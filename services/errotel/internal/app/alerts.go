package app

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

var alertLabelPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// PrepareAlert only renders configuration. It never contacts a notifier or stores rules.
func (a *App) PrepareAlert(_ context.Context, req *oas.AlertPreparation) (*oas.AlertConfigurationHeaders, error) {
	var search Search
	if err := decodeAPI(canonical(req), &search); err != nil {
		return nil, err
	}

	if err := a.validateAlert(req, search.Filter); err != nil {
		return nil, err
	}

	expression := a.alertCountQuery(&search, req.WindowSeconds) + " | filter errors:>=" + strconv.Itoa(req.Threshold)
	// vmalert expands environment references before parsing YAML, including quoted scalars.
	if strings.Contains(expression, "%{") || strings.Contains(string(canonical(search.Filter)), "%{") {
		return nil, requestError("alert_export_does_not_support_environment_placeholders_in_filters_or_mapping")
	}

	labels := map[string]string{"errotel_source": a.cfg.Source}
	for key, value := range req.Labels {
		labels[key] = value
	}

	rule := map[string]any{
		"alert": req.Name, "expr": expression, "for": seconds(req.ForSeconds), "labels": labels,
		"annotations": map[string]string{
			"summary": "Matching errors reached the configured threshold",
			"description": fmt.Sprintf(
				"{{ $value }} errors in %s (threshold %d). SDK retries count once per eventId.",
				seconds(req.WindowSeconds), req.Threshold),
			// A Go-template string literal prevents user-supplied URLs from becoming template code.
			"errotel_url": "{{ " + strconv.Quote(req.SearchUrl) + " }}",
		},
	}
	groups := map[string]any{"groups": []any{map[string]any{
		"name": "errotel_" + req.Name, "type": "vlogs", "interval": seconds(req.IntervalSeconds), "rules": []any{rule},
	}}}
	vmRule := map[string]any{
		"apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMRule",
		"metadata": map[string]any{
			"name":      "errotel-" + strings.Trim(strings.ReplaceAll(strings.ToLower(req.Name), "_", "-"), "-") + "rule",
			"namespace": req.Namespace, "labels": map[string]string{"app.kubernetes.io/part-of": "errotel"},
		},
		"spec": groups,
	}

	rulesYAML, err := renderAlertYAML(groups)
	if err != nil {
		return nil, err
	}

	vmYAML, err := renderAlertYAML(vmRule)
	if err != nil {
		return nil, err
	}

	amYAML, err := alertmanagerFragment(req, labels)
	if err != nil {
		return nil, err
	}

	return &oas.AlertConfigurationHeaders{Response: oas.AlertConfiguration{
		Expression: expression, RulesYaml: rulesYAML, VmRuleYaml: vmYAML,
		AlertmanagerYaml: amYAML, Instructions: alertInstructions,
		Source: a.cfg.Source, MappingRevision: fmt.Sprintf("%x", sha256.Sum256(canonical(a.cfg.Fields))),
	}}, nil
}

func seconds(value int) string { return strconv.Itoa(value) + "s" }

func (a *App) validateAlert(req *oas.AlertPreparation, filter *SearchFilter) error {
	if err := req.Validate(); err != nil {
		return requestError("invalid_alert_configuration")
	}

	if err := validateSearchFilter(filter); err != nil {
		return err
	}

	if time.Duration(req.WindowSeconds)*time.Second > a.cfg.Queries.MaxRange {
		return requestError("alert_window_exceeds_max_range")
	}

	if req.IntervalSeconds > req.WindowSeconds {
		return requestError("alert_interval_must_not_exceed_window")
	}

	return validateAlertLiterals(req, a.cfg.Source)
}

func validateAlertLiterals(req *oas.AlertPreparation, source string) error {
	link, err := url.Parse(req.SearchUrl)
	if err != nil || (link.Scheme != schemeHTTP && link.Scheme != schemeHTTPS) ||
		link.Host == "" || link.User != nil || link.RawQuery != "" || link.ForceQuery {
		return requestError("invalid_alert_search_url")
	}
	// The link is rendered as text and is never fetched by Errotel.
	if strings.Contains(req.SearchUrl, "%{") || strings.Contains(source, "%{") || strings.Contains(source, "{{") {
		return requestError("alert_export_does_not_support_environment_or_template_placeholders")
	}

	return validateAlertLabels(req.Labels)
}

func validateAlertLabels(labels oas.AlertPreparationLabels) error {
	for key, value := range labels {
		if !alertLabelPattern.MatchString(key) || strings.HasPrefix(key, "__") ||
			key == "alertname" || key == "errotel_source" {
			return requestError("invalid_or_reserved_alert_label")
		}

		if strings.Contains(value, "%{") || strings.Contains(value, "{{") {
			return requestError("alert_labels_must_be_literal_without_environment_or_template_placeholders")
		}
	}

	return nil
}

func (a *App) alertCountQuery(search *Search, window int) string {
	sdk := a.matchingQuery(search, originSDK)
	vanilla := a.matchingQuery(search, originOTel)

	return "_time:" + seconds(window) + " AND ((" + sdk + ") OR (" + vanilla + "))" +
		" | stats count_uniq(" + a.field("eventId") + ") if (" + sdk + ") as sdk_count," +
		" count() if (" + vanilla + ") as otel_count" +
		" | math sdk_count+otel_count as errors | fields errors"
}

func renderAlertYAML(value any) (string, error) {
	data, err := yaml.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("render alert configuration: %w", err)
	}

	return string(data), nil
}

func alertmanagerFragment(req *oas.AlertPreparation, labels map[string]string) (string, error) {
	matchers := []string{
		"errotel_source=" + strconv.Quote(labels["errotel_source"]), "alertname=" + strconv.Quote(req.Name),
	}

	fragment := map[string]any{"route": map[string]any{"routes": []any{map[string]any{
		"receiver": req.Receiver, "matchers": matchers,
		"group_by":   []string{"alertname", "errotel_source"},
		"group_wait": "30s", "group_interval": "5m", "repeat_interval": "4h",
	}}}}
	if req.NewTelegramReceiver {
		//nolint:gosec // Exported secret-file path and chat placeholder, no embedded credential.
		fragment["receivers"] = []any{map[string]any{"name": req.Receiver, "telegram_configs": []any{map[string]any{
			"bot_token_file": "/run/secrets/telegram-bot-token", "chat_id": "REPLACE_WITH_NUMERIC_CHAT_ID",
			"parse_mode": "", "send_resolved": true,
			"message": "{{ range .Alerts }}{{ .Status }}: {{ .Labels.alertname }}\n" +
				"{{ .Annotations.description }}\n{{ .Annotations.errotel_url }}\n{{ end }}",
		}}}}
	}

	result, err := renderAlertYAML(fragment)

	return "# MERGE FRAGMENT, not a replacement for alertmanager.yml.\n" + result, err
}

const alertInstructions = `Configuration prepared; nothing is enabled or installed by Errotel.

Flow: VictoriaLogs <- vmalert -> Alertmanager -> your existing receiver / Telegram.
Alertmanager routes notifications; vmalert evaluates the LogsQL condition. No open Errotel tab is required.

Ordinary vmalert (binary, systemd or Docker)
1. Save rules.yaml on the vmalert host; for Docker mount it read-only into the container.
2. Add -rule=/etc/vmalert/rules.yaml to the existing rule paths. Configure
   -datasource.url=http://VICTORIALOGS:9428 and -notifier.url=http://ALERTMANAGER:9093.
   Both addresses must be reachable FROM vmalert, not from your browser. For systemd put these
   flags in its ExecStart; for Docker use command and a read-only bind mount. A metrics datasource
   cannot execute this LogsQL rule: use a vmalert configured for VictoriaLogs if your existing one
   reads only VictoriaMetrics/Prometheus. Keep existing rule files and notifier settings.
3. Before applying: vmalert-prod -rule=/etc/vmalert/rules.yaml -dryRun
   Reload the configured vmalert using its documented /-/reload endpoint or restart the service.
   These flags and rules are tested with vmalert v1.151.0 and VictoriaLogs v1.52.0.

VM Operator / Kubernetes (optional)
Use vmrule.yaml instead of rules.yaml. Set metadata.namespace and metadata.labels to match your
VMAlert ruleNamespaceSelector and ruleSelector. The generated app.kubernetes.io/part-of label is
only a starting point; it does not guarantee selection. VMAlert must use a VictoriaLogs datasource
and the correct notifier address. Validate against your installed CRD with kubectl apply --dry-run=server.
If VMAlertmanagerConfig injects a namespace matcher, add the matching namespace ALERT LABEL in this
form as well; metadata.namespace alone is not an alert label. Manage Alertmanager config using your
existing Secret/Helm/VMAlertmanagerConfig workflow; the exported Alertmanager fragment is native YAML,
not a VMAlertmanagerConfig resource. Do not overwrite an operator-generated configuration file.

Alertmanager (including v0.32.1)
If existing routing already matches the alert labels, no Alertmanager change is needed.
Otherwise merge the child route into route.routes, preserving the root receiver and other routes.
Route order and continue determine whether an earlier sibling consumes the alert. Point receiver
at an EXISTING receiver, or append the optional new receiver. For Telegram replace
REPLACE_WITH_NUMERIC_CHAT_ID with an unquoted integer (negative group IDs are valid), mount the bot
secret at bot_token_file, and allow the bot to message the chat. Errotel never asks for the secret.
Plain-text Telegram messages avoid interpreting untrusted strings as HTML/Markdown.
Validate the COMPLETE merged file with amtool check-config /etc/alertmanager/alertmanager.yml,
then reload through your deployment's normal mechanism. Copying this fragment is not applying it.

Replicas and persistence
Errotel replicas need no shared volume: this generator stores no rules or notification state.
Rule files/configuration and any Alertmanager persistence remain owned by your deployment.
Multiple vmalert replicas must emit identical alert labels to the HA Alertmanager cluster;
replica-specific external labels prevent deduplication. Configure notification to all AM replicas
according to the vmalert/VM Operator HA documentation. Errotel does not set up HA or volumes.
Pending alert state may restart after a vmalert restart unless you configure its supported
remoteWrite/remoteRead state restoration separately. Errotel does not persist this state.

Semantics and verification
The rolling window replaces the search's absolute time range. SDK eventIds are counted uniquely
within each window; ordinary OTel exceptions count as stored records. ERROR severity alone is not
an exception. Conflicting bodies for one SDK eventId still count once; inspect the error in Errotel.
No per-error Telegram delivery is promised: Alertmanager groups/repeats stateful alerts.
for requires the condition to remain true across evaluations. A preview is a point-in-time count,
not a check of for, future delivery, rule selection or receiver credentials. vmalert evaluation delay,
late log arrival and overlapping windows can change the count. A query failure is not zero errors;
monitor vmalert health/evaluation errors independently. Large windows need upstream query capacity.
The link opens a rolling search relative to click time, not a stored alert-time occurrence.
Use the SAME VictoriaLogs source, field mapping, tenant headers and read credentials as Errotel;
configure those secrets directly in vmalert. Errotel does not export credentials. Regenerate after
mapping/source changes. Environment placeholders (%{...}) in filters/mappings and template expressions
in label values are rejected so vmalert cannot silently rewrite user literals.

References
https://docs.victoriametrics.com/victorialogs/vmalert/
https://docs.victoriametrics.com/operator/resources/vmalert/
https://docs.victoriametrics.com/operator/resources/vmrule/
https://docs.victoriametrics.com/operator/resources/vmalertmanagerconfig/
https://prometheus.io/docs/alerting/latest/configuration/#telegram_config
`
