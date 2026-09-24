# Review

Review lets authors explain code changes against specific source revisions.

## Language

**Headless authoring**:
Creating and editing a Review without installing or running the desktop application, including from a CI job.

**Source Access Mode**:
An explicit connection capability describing whether Whiteboard Desktop can open filesystem paths returned by its Review Server. It is not inferred from the server URL because an SSH-forwarded remote server also appears as `127.0.0.1`.

- **Shared-filesystem** means Desktop and Review Server can address the same paths. Source navigation may use `/navigator` and a Native Source Workspace.
- **API-only** means server filesystem paths are unavailable to Desktop. Source navigation uses API Source Editors.

**API Source Editor**:
A full-file, immutable Code OSS editor model identified by a `review-api-source://` URI and populated through the Review Server's source APIs. It supports pinned source inspection, syntax highlighting, line reveal, and API-backed diffs without a local repository checkout. It is not a remote IDE workspace.

**Native Source Workspace**:
The existing filesystem-backed Code OSS workspace prepared through `/navigator`. It opens a managed pinned Git worktree and provides normal workspace capabilities such as Explorer, search, language services, and cross-file navigation. It requires shared-filesystem Source Access Mode.

**Review Server Connection Profile**:
Desktop-owned configuration naming a Review Server URL, its Source Access Mode, and any external source opener. Profile metadata lives in ordinary settings; its Review Server Token is stored separately as a secret.

**Review Server Token**:
A bearer secret required by the Review Server's HTTP and WebSocket APIs. The current server generates a process-scoped token at startup and writes it to its local discovery record. It is not a Pi, GitHub, SSH, Tailscale, or model-provider credential.
