# Making `/share/` reachable through an auth gate

dsh-share-room's guest pages live under `/share/<shareId>/` and authenticate
guests themselves (single-use invite → share-scoped cookie). The stock DSH
webserver has no global login gate, so they work out of the box.

If you run a gate in front of the whole web server — such as
[`@summersec/dsh-web-auth`](https://www.npmjs.com/package/@summersec/dsh-web-auth) —
it must let `/share/` through **without** opening anything else.

`web-auth-public-prefixes.patch` adds an opt-in option to dsh-web-auth 0.2.0:

```yaml
- id: webserver-auth
  name: '@summersec/dsh-web-auth'
  config:
    publicPrefixes: ['/share']
```

Guarantees of the patch:

- Default is `[]`: nothing changes unless you opt in.
- Only single path segments are accepted; `/api`, `/auth`, `/assets`,
  `/plugins` and `/static` are refused at startup.
- Only a **plugin prefix route registered inside** the public prefix may answer.
  The GUI fallback, exact routes and WebSocket upgrades stay behind the login.
- Non-canonical paths (`.`/`..` segments, doubled slashes, backslashes, encoded
  `/`, `\` or `.`) are never treated as public, so `/share/../api` stays gated.

The plan is to offer this upstream as a PR; until then, vendor the patched file.
