// Package build contains metadata injected by the release build.
package build

import "github.com/google/uuid"

// These strings are linker targets; development builds keep explicit defaults.
//
//nolint:gochecknoglobals // Go -ldflags -X requires package variables.
var (
	ServiceName = "errotel"
	Version     = "dev"
	Commit      = "unknown"
	BuildTime   = "unknown"
	InstanceID  = uuid.NewString()
)
