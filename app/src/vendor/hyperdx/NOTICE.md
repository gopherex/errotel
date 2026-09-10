Source: https://github.com/hyperdxio/hyperdx
Commit: fda038d630ef66963d90399648dc7d107c0ca69f
License: MIT; copyright 2023 DeploySentinel, Inc. (see LICENSE).

Vendored presentation components: HyperJson, TimelineChart and their local helpers/styles.
Adaptations: relative imports, styles and safe JSON rendering; Errotel loads data through its generated read API. Theme palette and typography in ../../theme.ts derive from this commit.

`getMaxEventValue` uses a minimum 1 μs axis for zero-duration spans (durations are unchanged).
Large strings have an explicit preview/expand control; copying retains the full value.
