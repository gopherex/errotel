//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/docker/go-connections/nat"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/network"
	"github.com/testcontainers/testcontainers-go/wait"
	"go.yaml.in/yaml/v3"

	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

const (
	alertImage = "victoriametrics/vmalert:v1.151.0@sha256:" +
		"e519f14c31f4d68015702e684a0fc3f1b4e559aa985d8f4462768f07f55b05c9"
	amImage = "prom/alertmanager:v0.32.1@sha256:" +
		"51a825c2a40acc3e338fdd00d622e01ec090f72be2b3ea46be0839cd47a4d286"
)

type alertInstance struct {
	container testcontainers.Container
	url       string
}

func alertContainer(t *testing.T, net, alias, image string, port nat.Port, health string,
	cmd []string, files []testcontainers.ContainerFile,
) alertInstance {
	t.Helper()
	container, err := testcontainers.GenericContainer(t.Context(), testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image: image, ExposedPorts: []string{string(port)}, Cmd: cmd, Files: files,
			Networks: []string{net}, NetworkAliases: map[string][]string{net: {alias}},
			WaitingFor: wait.ForHTTP(health).WithPort(port).WithStartupTimeout(time.Minute),
		}, Started: true,
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, container.Terminate(context.Background())) })
	host, err := container.Host(t.Context())
	require.NoError(t, err)
	mapped, err := container.MappedPort(t.Context(), port)
	require.NoError(t, err)

	return alertInstance{container: container, url: "http://" + host + ":" + mapped.Port()}
}

func containerFile(path, value string) testcontainers.ContainerFile {
	return testcontainers.ContainerFile{Reader: strings.NewReader(value), ContainerFilePath: path, FileMode: 0o644}
}

func seedAlertRows(t *testing.T, endpoint string) {
	t.Helper()
	// 2 SDK IDs (one delivered twice with conflicting bodies), 2 vanilla exceptions, and an ERROR-only log.
	data := strings.Join([]string{
		`{"app.debug.kind":"exception","app.debug.event.id":` +
			`"11111111-1111-4111-8111-111111111111","service.name":"alerts-test",` +
			`"exception.type":"TestError","_msg":"original"}`,
		`{"app.debug.kind":"exception","app.debug.event.id":` +
			`"11111111-1111-4111-8111-111111111111","service.name":"alerts-test",` +
			`"exception.type":"TestError","_msg":"conflict"}`,
		`{"app.debug.kind":"exception","app.debug.event.id":` +
			`"22222222-2222-4222-8222-222222222222","service.name":"alerts-test",` +
			`"exception.type":"TestError"}`,
		`{"exception.type":"VanillaError","service.name":"alerts-test"}`,
		`{"event_name":"exception","service.name":"alerts-test"}`,
		`{"severity":"ERROR","service.name":"alerts-test","_msg":"not an exception"}`,
	}, "\n")
	req, err := http.NewRequestWithContext(
		t.Context(), http.MethodPost, endpoint+"/insert/jsonline", strings.NewReader(data))
	require.NoError(t, err)
	response, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
}

func statsCount(t *testing.T, endpoint, query string) []any {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, endpoint+"/select/logsql/stats_query",
		strings.NewReader(url.Values{"query": {query}}.Encode()))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode, string(data))

	var result struct {
		Data struct {
			Result []any `json:"result"`
		} `json:"data"`
	}

	require.NoError(t, json.Unmarshal(data, &result))

	return result.Data.Result
}

func TestExportedAlertRealEvaluationAndRouting(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", testToken)
	net, err := network.New(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, net.Remove(context.Background())) })
	logs := alertContainer(t, net.Name, "logs", logsImage, "9428/tcp", "/health", nil, nil)
	logsURL := logs.url
	seedAlertRows(t, logsURL)
	_, client := startAPI(t, logsURL, "", "")
	req := &oas.AlertPreparation{
		Name: "SyntheticErrors", WindowSeconds: 300, IntervalSeconds: 5, Threshold: 4,
		Labels: oas.AlertPreparationLabels{"team": "synthetic"}, Namespace: "monitoring", Receiver: "discard",
		SearchUrl: "https://errotel.example/#/?q=service%3Aalerts-test",
		Filter: oas.NewOptSearchFilter(oas.SearchFilter{
			Op: oas.SearchFilterOpEq, Field: oas.NewOptSearchFilterField(oas.SearchFilterFieldService),
			Value: oas.NewOptString("alerts-test"),
		}),
	}
	generated, err := client.PrepareAlert(t.Context(), req)
	require.NoError(t, err)

	query := generated.Response.Expression

	require.Eventually(t, func() bool { return len(statsCount(t, logsURL, query)) == 1 }, 15*time.Second, time.Second)
	count := statsCount(t, logsURL, query)[0].(map[string]any)["value"].([]any)[1]
	require.Equal(t, "4", count, "SDK duplicate/conflict once, two vanilla exceptions, no ERROR-only row")
	require.Empty(t, statsCount(t, logsURL, strings.Replace(query, "errors:>=4", "errors:>=5", 1)))
	require.Empty(t, statsCount(t, logsURL, strings.ReplaceAll(query, "alerts-test", "absent-service")))
	// Same generated query handles origin filters and literal query-injection strings.
	for _, value := range []string{"sdk", "otel-log"} {
		req.Filter = oas.NewOptSearchFilter(oas.SearchFilter{
			Op: oas.SearchFilterOpEq, Field: oas.NewOptSearchFilterField(oas.SearchFilterFieldOrigin),
			Value: oas.NewOptString(value),
		})
		req.Threshold = 1
		response, prepareErr := client.PrepareAlert(t.Context(), req)
		require.NoError(t, prepareErr)
		rows := statsCount(t, logsURL, response.Response.Expression)
		require.Len(t, rows, 1)
		require.Equal(t, "2", rows[0].(map[string]any)["value"].([]any)[1])
	}

	req.Filter = oas.NewOptSearchFilter(oas.SearchFilter{
		Op: oas.SearchFilterOpEq, Field: oas.NewOptSearchFilterField(oas.SearchFilterFieldService),
		Value: oas.NewOptString("x\" OR * | stats count()"),
	})
	injected, err := client.PrepareAlert(t.Context(), req)
	require.NoError(t, err)
	require.Empty(t, statsCount(t, logsURL, injected.Response.Expression))

	// Validate the native Alertmanager fragment as part of a complete file, with an inert receiver.
	var amConfig map[string]any

	require.NoError(t, yaml.Unmarshal([]byte(generated.Response.AlertmanagerYaml), &amConfig))

	amConfig["route"].(map[string]any)["receiver"] = "discard"
	amConfig["receivers"] = []any{map[string]any{"name": "discard"}}
	amYAML, err := yaml.Marshal(amConfig)
	require.NoError(t, err)
	// Telegram template is parsed by the exact requested Alertmanager version, never run or sent.
	req.NewTelegramReceiver = true
	telegram, err := client.PrepareAlert(t.Context(), req)
	require.NoError(t, err)

	var tgConfig map[string]any

	require.NoError(t, yaml.Unmarshal([]byte(telegram.Response.AlertmanagerYaml), &tgConfig))

	tgConfig["route"].(map[string]any)["receiver"] = "discard"
	tg := tgConfig["receivers"].([]any)[0].(map[string]any)["telegram_configs"].([]any)[0].(map[string]any)
	tg["chat_id"] = -123456789
	tgYAML, err := yaml.Marshal(tgConfig)
	require.NoError(t, err)
	manager := alertContainer(t, net.Name, "am", amImage, "9093/tcp", "/-/ready",
		[]string{"--config.file=/etc/alertmanager/active.yml", "--storage.path=/tmp/am", "--cluster.listen-address="},
		[]testcontainers.ContainerFile{
			containerFile("/etc/alertmanager/active.yml", string(amYAML)),
			containerFile("/etc/alertmanager/telegram.yml", string(tgYAML)),
			containerFile("/run/secrets/telegram-bot-token", "synthetic-unused"),
		})
	code, output, err := manager.container.Exec(
		t.Context(), []string{"/bin/amtool", "check-config", "/etc/alertmanager/telegram.yml"})
	require.NoError(t, err)
	checkOutput, err := io.ReadAll(output)
	require.NoError(t, err)
	require.Zero(t, code, string(checkOutput))
	evaluator := alertContainer(t, net.Name, "evaluator", alertImage, "8880/tcp", "/health",
		[]string{
			"-rule=/etc/vmalert/rules.yml", "-datasource.url=http://logs:9428", "-notifier.url=http://am:9093",
			"-rule.evalDelay=0s",
		},
		[]testcontainers.ContainerFile{containerFile("/etc/vmalert/rules.yml", generated.Response.RulesYaml)})
	code, output, err = evaluator.container.Exec(
		t.Context(), []string{"/vmalert-prod", "-rule=/etc/vmalert/rules.yml", "-dryRun"})
	require.NoError(t, err)
	checkOutput, err = io.ReadAll(output)
	require.NoError(t, err)
	require.Zero(t, code, string(checkOutput))
	require.Eventually(t, func() bool {
		request, reqErr := http.NewRequestWithContext(t.Context(), http.MethodGet, manager.url+"/api/v2/alerts", http.NoBody)
		require.NoError(t, reqErr)

		response, getErr := http.DefaultClient.Do(request)
		if getErr != nil {
			return false
		}

		defer response.Body.Close()

		var alerts []struct {
			Labels    map[string]string `json:"labels"`
			Receivers []struct {
				Name string `json:"name"`
			} `json:"receivers"`
		}

		if json.NewDecoder(response.Body).Decode(&alerts) != nil {
			return false
		}

		for _, alert := range alerts {
			if alert.Labels["alertname"] == "SyntheticErrors" && alert.Labels["team"] == "synthetic" &&
				len(alert.Receivers) == 1 && alert.Receivers[0].Name == "discard" {
				return true
			}
		}

		return false
	}, 25*time.Second, time.Second, "vmalert must evaluate the exported rule and send it to isolated Alertmanager")
}
