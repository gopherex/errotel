package envelope_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

func TestExceptionProjectionRoundTrip(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{
		`{"mechanism":"manual","message":"old record without cause"}`,
		`{"mechanism":"manual",
          "cause":{"message":"root","cause":{"incomplete":"cycle"},"extra":{"null":null,"false":false}},"errors":[]}`,
		`{"mechanism":"unhandledrejection",
          "errors":[{"message":"first"},{"cause":{"message":"second"}}],"incomplete":"limit"}`,
	} {
		var exception oas.WireException

		require.NoError(t, json.Unmarshal([]byte(raw), &exception))

		encoded, err := json.Marshal(&exception)
		require.NoError(t, err)
		require.JSONEq(t, raw, string(encoded), "Go projection must preserve optional fields and nested JSON")
	}
}
