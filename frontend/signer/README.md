# Lighter signer (WebAssembly)

`lighter-signer.wasm.gz` is Lighter's official transaction signer, built unchanged from
[elliottech/lighter-go](https://github.com/elliottech/lighter-go) (Apache License 2.0), package `./wasm/`.
It exposes the same functions as the signer library the Python SDK uses (`SignCreateOrder`,
`SignCancelOrder`, `SignModifyOrder`, `SignUpdateLeverage`, `CreateAuthToken`, …), so orders signed in
the browser are the same transactions the server would sign.

`wasm_exec.js` is the loader that ships with Go (BSD-style licence, Copyright The Go Authors).

LighterDeck loads both only when an API key is connected in the browser (`live.js`); the key never
leaves the browser.

## Build

- source: lighter-go commit `aefa96848a105d82a6bbb55d3d05663293a71713`
- Go 1.26.8, then gzip -9 -n

```
CGO_ENABLED=0 GOOS=js GOARCH=wasm go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o lighter-signer.wasm ./wasm/
gzip -9 -n lighter-signer.wasm
```

- sha256 of `lighter-signer.wasm`: `a6b66ca455ee3f2b88cd6520ee09139c04305d081c3cf326fc8c84d82df80e40`
- `wasm_exec.js` from the same Go release (`$GOROOT/lib/wasm/wasm_exec.js`)
