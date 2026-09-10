package envelope

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/santhosh-tekuri/jsonschema/v6"

	_ "embed"
)

//go:embed app-debug-v1.schema.json
var raw []byte

func New() (*jsonschema.Schema, error) {
	compiler := jsonschema.NewCompiler()

	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("decode schema: %w", err)
	}

	if err := compiler.AddResource("urn:app-debug:envelope:1", document); err != nil {
		return nil, fmt.Errorf("register schema: %w", err)
	}

	schema, err := compiler.Compile("urn:app-debug:envelope:1")
	if err != nil {
		return nil, fmt.Errorf("compile schema: %w", err)
	}

	return schema, nil
}

func Decode(raw string) (map[string]any, error) {
	var value map[string]any

	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.UseNumber()

	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("decode envelope: %w", err)
	}

	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("trailing envelope content: %w", &json.SyntaxError{})
	}

	return value, nil
}
