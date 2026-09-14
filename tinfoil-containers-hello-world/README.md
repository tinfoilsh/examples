# Tinfoil Containers — Hello World

A minimal Docker image to play with [Tinfoil Containers](https://docs.tinfoil.sh/containers/overview): a tiny Go HTTP server, built and published from this repo. To deploy it inside a [secure enclave](https://docs.tinfoil.sh/containers/overview), use [`tinfoil-containers-template`](https://github.com/tinfoilsh/tinfoil-containers-template).

The server reads a `MESSAGE` env var and a `GREETING_TOKEN` secret, and responds on every path with:

```
MESSAGE: Hello from a Tinfoil Container!
GREETING_TOKEN: present
```

(`GREETING_TOKEN: absent` if the secret isn't set.)

## Build off of this

1. Click **[Use this template](https://github.com/tinfoilsh/tinfoil-containers-hello-world/generate)**
2. Edit `main.go` (or swap it for your own code), then release a version by running the **Tinfoil Release** workflow — this builds your image and pushes it to GHCR:
   ```bash
   gh workflow run tinfoil-release.yml -f version=v0.0.1
   ```
3. Reference `ghcr.io/<your-org>/<your-repo>` from a [`tinfoil-containers-template`](https://github.com/tinfoilsh/tinfoil-containers-template) repo to deploy it

## What's Inside

- **`main.go`** — ~20-line `net/http` server, stdlib only
- **`Dockerfile`** — multi-stage `golang:1.26.2-alpine` → `scratch`, ~5 MB final image
- **`.github/workflows/tinfoil-release.yml`** — manual dispatch: builds, pushes to GHCR, tags, creates a GitHub release with the image digest
