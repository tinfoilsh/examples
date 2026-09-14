# Tinfoil Containers — Hello World

A minimal Docker image to play with [Tinfoil Containers](https://docs.tinfoil.sh/containers/overview): a tiny Go HTTP server, built and published from this repo. To deploy it inside a [secure enclave](https://docs.tinfoil.sh/containers/overview), use [`tinfoil-containers-template`](https://github.com/tinfoilsh/tinfoil-containers-template).

The server reads a `MESSAGE` env var and a `GREETING_TOKEN` secret, and responds on every path with:

```
MESSAGE: Hello from a Tinfoil Container!
GREETING_TOKEN: present
```

(`GREETING_TOKEN: absent` if the secret isn't set.)

## Build off of this

1. [Fork the examples repository](https://github.com/tinfoilsh/examples/fork).
2. Edit `tinfoil-containers-hello-world/main.go` (or swap it for your own code), then release a version by running the **Release Hello World** workflow from your fork's repository root — this builds your image and pushes it to GHCR:
   ```bash
   gh workflow run release-hello-world.yml -f version=v0.0.1
   ```
3. Reference `ghcr.io/<your-org>/<your-repo>/hello-world@sha256:<digest>` from a [`tinfoil-containers-template`](https://github.com/tinfoilsh/tinfoil-containers-template) repo to deploy it. The workflow publishes the digest in a GitHub release tagged `hello-world/<version>`.

For a local build, run `docker build -t hello-world .` from this example's directory. The workflow uses that same directory as its build context.

## What's Inside

- **`main.go`** — ~20-line `net/http` server, stdlib only
- **`Dockerfile`** — multi-stage `golang:1.26.2-alpine` → `scratch`, ~5 MB final image
- **[`.github/workflows/release-hello-world.yml`](../.github/workflows/release-hello-world.yml)** — repository-root manual workflow: builds, pushes to GHCR, tags, creates a GitHub release with the image digest
