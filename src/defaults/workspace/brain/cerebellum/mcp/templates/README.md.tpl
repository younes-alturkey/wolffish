# __TITLE__

__DESCRIPTION__

## Run

```bash
npm install
node server.mjs
```

stderr should print `__SLUG__ ready on stdio`. Nothing appears on stdout until a
client speaks to it — that is correct.

## Connect it to Wolffish

```
mcp_add  name: __SLUG__  command: node __ABSPATH__/server.mjs
mcp_test name: __SLUG__
```

Its tools arrive on the next turn. After editing the server, `mcp_remove` then
`mcp_add` again to reload it. `mcp_remove` when you are done testing, unless the
user wants it kept.

## Before calling it done

Connecting proves nothing. Write five to ten realistic, multi-step, read-only
questions this server should be able to answer, then answer them using only its
tools. Every question that needed something you only know from having written the
code is a missing or badly described tool — that is the finding.

## Tools

- `__PREFIX___list_items` — paginated, filterable list. Replace `listItems()` with
  the real call, then add tools one at a time, each with its description and its
  error paths.
