# Review

Review lets authors explain code changes against specific source revisions.

## Language

### Review and changes

**Review**:
A container for an author's explanation of source changes, including its Document and Lenses.

**Document**:
The narrative of a Review, presented in the Whiteboard tab. It is distinct from the Lenses alongside it.

**Review Snapshot**:
A version of a Review's authored state, including its Document and Lenses. It is not an archive of the source itself.

**Review Target**:
The source and comparison a Review is set against, such as a checkout or fixed commits. It is distinct from a Lens Target.

**Diff**:
The result of comparing source states, including their changed files and lines.

**Diff View**:
The Review surface for inspecting a Diff and optionally filtering it through a Lens.

**Lens**:
A named, saved selection of changed lines in a Review, defined by one or more Lens Targets. “File lenses” is a historical name for Lenses, not a separate concept.

**Lens Target**:
A specification of the changes a Lens selects, using file patterns or source ranges. A Lens Target is distinct from the Review Target.

**Active Lens**:
The Lens currently selected as a filter in the Diff View; selecting it again clears the filter.

**Uncategorized Changes**:
Changed lines in the Diff not selected by any available Lens, regardless of whether they have been viewed.

**Source Reference**:
A reference to a location in source, optionally tied to its own source revisions. It can provide context in a Document or specify a range for a Lens.

### Authoring and source access

**Review Server**:
The Whiteboard service that owns Reviews and provides their authoring and source access to clients.

**Review Server Discovery**:
The connection details a client uses to find and authenticate to a running Review Server, including its endpoint and credential. It is distinct from finding a repository or Review; the headless server publishes the details and the authoring client reads them.
_Avoid_: Discovery without qualification

**Authoring API**:
The supported caller-facing interface through which agents and CLI clients author Reviews. “Public” describes the interface offered to callers, not Internet exposure or unauthenticated access.
_Avoid_: Public authoring API

**Authoring Activity**:
The live authoring state of a Review, including its active scopes and any reported focus. It summarizes activity across leases rather than being a lease itself.

**Authoring Lease**:
A temporary exclusive claim to author one Review scope, such as the Document or Lenses. Separate scopes can be held concurrently, and a lease ends or expires independently of a Review Snapshot.
_Avoid_: Session without qualification

**Command Receipt**:
A recorded command request and result that lets an identical retry return the same result without repeating the operation. Reusing its command identity for different input is rejected.

**Source Pins**:
A repository and source revisions identifying where a Source Reference or Review's source was read. A Source Reference may carry its own pins instead of using the Review's default pins.

**Registered Repository**:
A repository checkout known to a Review Server for source access and association with Reviews and resources.

**Review Resource**:
An asset associated with a registered repository that Review content can reference, such as an image or trace.

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
A bearer secret required by the Review Server's HTTP and WebSocket APIs. It is operator-configured and restart-stable for durable headless connections, or server-generated and process-scoped for local and ephemeral operation; it is not a Pi, GitHub, SSH, Tailscale, or model-provider credential.
