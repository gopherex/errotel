package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"go.yaml.in/yaml/v3"

	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

func alertRequest() *oas.AlertPreparation {
	return &oas.AlertPreparation{
		Name: "CheckoutErrors", WindowSeconds: 300, IntervalSeconds: 30, ForSeconds: 0, Threshold: 2,
		Labels: oas.AlertPreparationLabels{"team": "frontend"}, Namespace: "monitoring", Receiver: "telegram",
		SearchUrl: "https://errotel.example/#/?q=service%3Acheckout",
	}
}

func TestPrepareAlertConfiguration(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "alert-test")

	cfg, err := LoadConfig("")
	require.NoError(t, err)

	cfg.Fields = map[string]string{"service": "custom.service"}
	cfg.Logs.BaseURL = "http://127.0.0.1:1"
	application, err := New(&cfg, nil)
	require.NoError(t, err)

	defer application.Close()

	req := alertRequest()
	req.Filter = oas.NewOptSearchFilter(oas.SearchFilter{
		Op: oas.SearchFilterOpEq, Field: oas.NewOptSearchFilterField(oas.SearchFilterFieldService),
		Value: oas.NewOptString("checkout\" OR * | limit 1\n<script>"),
	})
	result, err := application.PrepareAlert(t.Context(), req)
	require.NoError(t, err)
	require.Contains(t, result.Response.Expression, `"custom.service":="checkout\" OR * | limit 1\n<script>"`)
	require.Contains(t, result.Response.Expression, "count_uniq(")
	require.Contains(t, result.Response.Expression, "_time:300s")
	require.Contains(t, result.Response.Expression, "| filter errors:>=2")
	require.NotContains(t, result.Response.RulesYaml, "alert-test")

	var rules, resource map[string]any

	require.NoError(t, yaml.Unmarshal([]byte(result.Response.RulesYaml), &rules))
	require.NoError(t, yaml.Unmarshal([]byte(result.Response.VmRuleYaml), &resource))
	require.Equal(t, rules, resource["spec"])
	require.Equal(t, "VMRule", resource["kind"])
	require.NotContains(t, result.Response.AlertmanagerYaml, "telegram_configs")

	req.NewTelegramReceiver = true
	result, err = application.PrepareAlert(t.Context(), req)
	require.NoError(t, err)
	require.Contains(t, result.Response.AlertmanagerYaml, "REPLACE_WITH_NUMERIC_CHAT_ID")
	require.Contains(t, result.Response.AlertmanagerYaml, `parse_mode: ""`)
	require.NotContains(t, result.Response.AlertmanagerYaml, "bot_token:")
	// Preparation must work even with a completely unavailable upstream, but requires authentication.
	body := string(canonical(req))
	for _, token := range []string{"alert-test", "wrong"} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/prepare", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)

		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, request)

		if token == "alert-test" {
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		} else {
			require.Equal(t, http.StatusUnauthorized, response.Code)
		}
	}
}

func TestAlertRejectsUnsafeOrInvalidInputs(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "alert-test")

	cfg, err := LoadConfig("")
	require.NoError(t, err)

	cfg.Logs.BaseURL = "http://127.0.0.1:1"
	application, err := New(&cfg, nil)
	require.NoError(t, err)

	defer application.Close()

	for _, change := range []func(*oas.AlertPreparation){
		func(r *oas.AlertPreparation) { r.Threshold = 0 },
		func(r *oas.AlertPreparation) { r.WindowSeconds = 0 },
		func(r *oas.AlertPreparation) { r.IntervalSeconds = 301 },
		func(r *oas.AlertPreparation) { r.Name = "a\nb" },
		func(r *oas.AlertPreparation) { r.SearchUrl = "javascript:alert(1)" },
		func(r *oas.AlertPreparation) { r.SearchUrl = "https://u:secret@example/" },
		func(r *oas.AlertPreparation) { r.SearchUrl = "https://example/?token=secret" },
		func(r *oas.AlertPreparation) { r.Labels["alertname"] = "another" },
		func(r *oas.AlertPreparation) { r.Labels["__name__"] = "another" },
		func(r *oas.AlertPreparation) { r.Labels["team"] = "{{ query `up` }}" },
		func(r *oas.AlertPreparation) { r.Labels["team"] = "%{SECRET}" },
		func(r *oas.AlertPreparation) {
			r.Filter = oas.NewOptSearchFilter(oas.SearchFilter{
				Op: oas.SearchFilterOpEq, Field: oas.NewOptSearchFilterField(oas.SearchFilterFieldService),
				Value: oas.NewOptString("%{SECRET}"),
			})
		},
	} {
		req := alertRequest()
		change(req)
		_, err := application.PrepareAlert(context.Background(), req)
		require.Error(t, err)
	}

	application.cfg.Fields["service"] = "%{MAPPING}"
	req := alertRequest()
	req.Filter = oas.NewOptSearchFilter(oas.SearchFilter{
		Op: oas.SearchFilterOpExists, Field: oas.NewOptSearchFilterField(oas.SearchFilterFieldService),
	})
	_, err = application.PrepareAlert(t.Context(), req)
	require.Error(t, err)
}
