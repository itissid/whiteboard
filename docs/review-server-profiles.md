# Review Server Connection Profiles

Whiteboard Desktop can save multiple named Review Server Connection Profiles. Each profile contains a Review Server URL and an explicit API-only Source Access Mode. Profile names, URLs, identifiers, and the active selection are ordinary Desktop settings; Review Server Tokens are stored separately in the operating system's secret storage.

Whiteboard does not create or supervise network transport. Before adding a profile, make the Review Server endpoint reachable using transport managed outside Whiteboard and obtain its Review Server Token from the server operator.

## Add and manage profiles

Use the Command Palette to run:

- **Whiteboard: Add Review Server Profile...** to save and select a named endpoint.
- **Whiteboard: Switch Review Server Profile...** to select a different saved profile.
- **Whiteboard: Edit Review Server Profile...** to change any saved profile's name, URL, or token.
- **Whiteboard: Remove Review Server Profile...** to remove a saved profile and its stored token.

Selecting a profile is explicit and persists across Desktop restarts. Removing an inactive profile does not affect the active Review store. To remove an active profile while other profiles remain, switch to the intended replacement first. Removing the last profile explicitly returns Desktop to its default embedded Review Server.

## Recover from disconnection

When the selected server cannot be reached, Whiteboard keeps that profile selected and reports that the endpoint is unreachable. Check the endpoint and externally managed transport, then choose **Retry**.

When the selected server rejects its token, Whiteboard reports a credential failure separately. Choose **Edit credentials** to replace the token, then retry. **Switch profile** selects a different saved Review store only when you request it.

A failed connection never starts an embedded server or selects another profile automatically. The disconnected view continues to identify the selected profile until retry, credential editing, or an explicit switch succeeds.
