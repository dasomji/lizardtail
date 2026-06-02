# lizardtail

`lizardtail` runs a command, watches its output for a localhost server port, exposes that port with [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve), and prints the private tailnet URL.

```bash
lizardtail pnpm dev
```

```text
Local: http://localhost:5173

lizardtail: detected local server on http://127.0.0.1:5173
lizardtail: serving via Tailscale: https://my-host.tailabc.ts.net
```

Use it when your dev server is running on a remote machine and you want to open it from another device on your tailnet without manually copying ports or reconfiguring Tailscale Serve.

## Features

- Runs any command you pass it, such as `pnpm dev`, `npm run dev`, `bun run dev`, or `python -m http.server`.
- Streams the child command's stdout/stderr normally.
- Detects common dev-server output formats, including `http://localhost:5173`, `http://127.0.0.1:3000`, `started server on 0.0.0.0:8080`, and `PORT=4321`.
- Ignores timing output like `ready in 500 ms` so it does not accidentally expose port `500`.
- Waits briefly after the first candidate port so multi-process commands, such as Laravel plus Vite, can print the better app-server URL.
- Waits for the detected port to accept local connections before exposing it.
- Runs `tailscale serve --bg --https <tailscale-port> http://127.0.0.1:<port>`.
- Prints the HTTPS MagicDNS URL for the current Tailscale device.
- Supports an explicit `--port` when automatic detection is not possible.
- Supports `--tailscale-port` when you want the MagicDNS URL to include a specific HTTPS port.
- Detects Laravel + Vite dev output, exposes both servers, rewrites Laravel's `public/hot` file to the Tailscale Vite URL, and proxies Vite assets with CORS headers so module scripts can load cross-origin.
- Uses a stable alternate Tailscale HTTPS port by default: first free port from `8443` upward.
- Stays private to your tailnet by default.
- Supports `--public` / `--funnel` for intentional public internet sharing through Tailscale Funnel.
- Cleans up the Tailscale Serve/Funnel mappings it created when the child command exits or you press `Ctrl+C`.

## Requirements

- Node.js 20 or newer.
- Tailscale installed and available as `tailscale` on `PATH`.
- The device must be logged into Tailscale.
- Tailscale Serve must be available for the device/tailnet.
- For `--public`, Tailscale Funnel must be enabled for the device/tailnet.
- Your user must be allowed to update Tailscale Serve/Funnel config. If `tailscale serve` or `tailscale funnel` says access is denied, run this once:

  ```bash
  sudo tailscale set --operator=$USER
  ```

Check Tailscale before using `lizardtail`:

```bash
tailscale status
tailscale serve --help
# Optional, only for --public:
tailscale funnel --help
```

`lizardtail` exposes services to your private tailnet via Tailscale Serve by default. It only uses Tailscale Funnel, which publishes to the public internet, when you explicitly pass `--public` or `--funnel`.

## Installation

### From source

```bash
git clone https://github.com/dasomji/lizardtail.git
cd lizardtail
npm install
npm run build
npm link
```

Then run:

```bash
lizardtail --help
```

### During development

You can run the TypeScript source directly:

```bash
npm run dev -- pnpm dev
```

Or build and run the compiled CLI:

```bash
npm run build
node dist/index.js pnpm dev
```

## Usage

```bash
lizardtail [options] -- <command> [args...]
lizardtail [options] <command> [args...]
```

Use `--` when the command itself has flags that could be confused for `lizardtail` options:

```bash
lizardtail -- npm run dev -- --host 0.0.0.0
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--port <port>` | auto-detect | Expose this port instead of reading one from command output. |
| `--host <host>` | `127.0.0.1` | Local host to pass to Tailscale Serve. |
| `--timeout <ms>` | `30000` | How long to wait for a port to appear in command output. |
| `--tailscale-port <port>` | first free `8443+` | Expose the main app on this Tailscale HTTPS port and print it in the MagicDNS URL. Alias: `--https-port`. |
| `--vite-tailscale-port <port>` | first free `8443+` | Expose a detected Laravel Vite asset server on this Tailscale HTTPS port. Alias: `--vite-https-port`. |
| `--public`, `--funnel` | disabled | Use Tailscale Funnel for public internet access instead of private tailnet-only Serve. |
| `--no-open-check` | enabled | Skip waiting for the local port to accept connections before calling Tailscale. |
| `-h`, `--help` | | Show help. |

## Examples

### Vite / frontend dev server

```bash
lizardtail pnpm dev
```

If Vite is configured to bind to another host:

```bash
lizardtail --host localhost pnpm dev
```

### npm script with extra flags

```bash
lizardtail -- npm run dev -- --host 0.0.0.0
```

### Known port

```bash
lizardtail --port 3000 npm run dev
```

### MagicDNS URL with an explicit port

By default, `lizardtail` uses the first free Tailscale HTTPS port from `8443` upward, so multiple projects can be served at the same time:

```text
https://my-host.tailabc.ts.net:8443
```

You can also choose the Tailscale HTTPS port explicitly:

```bash
lizardtail --tailscale-port 8450 pnpm dev
```

That prints a URL like:

```text
https://my-host.tailabc.ts.net:8450
```

### Laravel / `composer run dev`

Laravel development commands often start both the PHP app server and the Vite asset server. When `lizardtail` sees both, it:

1. exposes the Laravel app server;
2. starts a small local proxy in front of Vite that adds CORS headers;
3. exposes that Vite proxy on a separate Tailscale HTTPS port;
4. writes `public/hot` to the Tailscale Vite URL so Laravel renders assets from the reachable Vite server.

```bash
lizardtail composer run dev
```

You can choose the Vite Tailscale port explicitly:

```bash
lizardtail --vite-tailscale-port 8453 composer run dev
```

`lizardtail` also sets `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` for the child command when it can read your Tailscale MagicDNS name. The local proxy handles CORS for module scripts loaded from the Vite Tailscale URL.

If your app server lands on a known port and you only want to expose that server, you can force it:

```bash
lizardtail --port 8001 composer run dev
```

### Public internet sharing

By default, URLs are only reachable from devices in your tailnet. To intentionally publish through Tailscale Funnel:

```bash
lizardtail --public pnpm dev
```

or:

```bash
lizardtail --funnel pnpm dev
```

This prints a public HTTPS URL such as:

```text
https://my-host.tailabc.ts.net:8443
```

Use this only for apps you are comfortable exposing publicly. Stop `lizardtail` with `Ctrl+C` to remove the Funnel mapping it created.

### Longer startup timeout

```bash
lizardtail --timeout 60000 pnpm dev
```

## How it works

1. `lizardtail` starts the command you provide.
2. It streams the command output to your terminal.
3. It scans recent output for a local port.
4. Once it finds a port, it waits for `127.0.0.1:<port>` or the configured `--host` to accept connections.
5. It chooses the first free Tailscale HTTPS port from `8443` upward, unless `--tailscale-port` was provided.
6. It runs Tailscale Serve for private tailnet-only access:

   ```bash
   tailscale serve --bg --https <tailscale-port> http://<host>:<port>
   ```

   With `--public` / `--funnel`, it runs Tailscale Funnel for public internet access:

   ```bash
   tailscale funnel --bg --https <tailscale-port> http://<host>:<port>
   ```

   On older Tailscale versions, if that form fails for `127.0.0.1`/`localhost`, it falls back to the same command with just `<port>` as the target.

7. It reads `tailscale status --json`, extracts the current device's MagicDNS name, and prints:

   ```text
   https://<device-name>.<tailnet>.ts.net:<tailscale-port>
   ```

## Shutdown behavior

When the child command exits, or when you press `Ctrl+C`, `lizardtail` removes the Tailscale mappings it created for that run:

```bash
tailscale serve --https=<port> off
# or, with --public:
tailscale funnel --https=<port> off
```

It only tracks ports created by the current `lizardtail` process.

## Troubleshooting

### No port detected

If the server does not print a recognizable port, pass it explicitly:

```bash
lizardtail --port 5173 pnpm dev
```

### Tailscale command fails

Verify Tailscale is running and logged in:

```bash
tailscale status
```

Then check Serve support and current mappings:

```bash
tailscale serve --help
tailscale serve status
```

### `Access denied: serve config denied`

Some Tailscale installs only allow root, or the configured Tailscale operator, to change Serve config. If you see:

```text
Access denied: serve config denied
Use 'sudo tailscale serve ...'
To not require root, use 'sudo tailscale set --operator=$USER' once.
```

run:

```bash
sudo tailscale set --operator=$USER
```

Then rerun `lizardtail`. This is a one-time local machine setup step.

### Browser cannot load assets

Some frameworks, especially full-stack apps with separate backend and Vite dev servers, may need more than one port exposed. `lizardtail` currently exposes the first detected or explicitly supplied port. Run a second `lizardtail --port <port> ...` command or configure Tailscale Serve manually for multi-port setups.

### Host checks or CORS failures

Some dev servers reject requests from the Tailscale hostname. Configure your dev server to allow the Tailscale MagicDNS host or to bind with the right host/CORS options. For example, Vite may need `--host 0.0.0.0` and framework-specific allowed-host settings.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The test suite uses Node's built-in test runner through `tsx` and includes:

- unit tests for argument parsing and port detection;
- an integration-style CLI test with a fake `tailscale` executable and a real temporary HTTP server.

## Contributing

Issues and pull requests are welcome. Please include tests for behavior changes and run:

```bash
npm test
```

before opening a pull request.

## License

MIT. See [LICENSE](./LICENSE).
