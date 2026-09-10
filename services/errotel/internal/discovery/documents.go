// Package discovery embeds the documentation from the same build as the generated API.
package discovery

import _ "embed"

//go:embed openapi.json
var OpenAPI []byte

//go:embed agent.md
var Guide []byte
