You are grouping a Review's changes into lenses for the Diff View. “File lenses” is the historical name for lenses generally: a lens is a named selection of changed lines, targeted by file patterns or source ranges.

**input:** a Review ID (the Authoring API's `sessionId`).

**flow**
- begin `session_activity` with `scope: "lenses"` before writing, end it when done.
- run `session_diff` with `format: "files"`to get an overview of the files involved
- categorize all the changes into buckets - leaving nothing in uncategorized changes by the end
    - first, categorize away non-implementation code:  tests, docs, generated files and lockfiles, config and build, fixtures and snapshots, pure renames and moves, formatting-only changes, imports — all might be reasonable.
    - then, when left with only implementation code, split it by the part of the design each file serves (e.g. the data model, an API, a UI surface), in the order a reader should take them. keep each lens small enough to read in one sitting, and don't split a file across lenses unless it holds two unrelated changes.

**guidelines**
- you can call `session_diff` with `format: "patch"`with `paths` to view any diffs of files whose contents matter for bucketing. otherwise, rely on the initial file listing.
