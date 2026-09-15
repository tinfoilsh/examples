# examples

Examples for building with [Tinfoil](https://tinfoil.sh).

| Example | Description |
| --- | --- |
| [Encrypted request proxy](encrypted-request-proxy-example) | Forward encrypted inference requests through your backend, with TypeScript and Swift clients. |
| [Encrypted session recovery](encrypted-session-recovery-example) | Resume encrypted streaming responses after a browser disconnect. |
| [Confidential secret storage](example-secret-storage) | Store encrypted data and deliver keys to attested consumer enclaves. |

## Getting started

```bash
git clone --recurse-submodules https://github.com/tinfoilsh/examples.git
cd examples
```

Open the README in the example you want to run, and run its commands from that example's directory. Each example manages its own dependencies.

The storage example uses two public deployment repositories as pinned submodules. If you cloned without submodules, initialize them from the repository root:

```bash
git submodule update --init --recursive
```

This repository does not have a root `tinfoil-config.yml` and is not itself a Tinfoil Containers deployment repository. The storage example's deployment configs remain in its component repositories.
