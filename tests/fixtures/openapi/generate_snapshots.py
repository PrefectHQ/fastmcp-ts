"""Regenerate the Python-parity snapshots in this directory.

The snapshots capture what Python FastMCP's OpenAPI integration
(`fastmcp.server.providers.openapi.OpenAPIProvider`, the machinery behind
`FastMCP.from_openapi`) generates for the fixture specs: component names,
descriptions, input schemas, output schemas, tags, resource URIs, and
template URI patterns. The TypeScript test suite deep-equals
`createOpenAPIServer` output against these files, so the two
implementations cannot drift silently.

Regenerate against a fastmcp checkout (requires the `server` extra):

    uv venv .tmp/parity-venv
    uv pip install --python .tmp/parity-venv/bin/python \
        '<fastmcp-checkout>/fastmcp_slim[server]'
    PYTHONHASHSEED=0 .tmp/parity-venv/bin/python tests/fixtures/openapi/generate_snapshots.py

Until the Python half of the access-mode change lands, run tests/fixtures/openapi/patch_parity_venv.py in the venv before regenerating (see that script's docstring).

`PYTHONHASHSEED=0` is required: the OpenAPI parser builds `$defs` by
iterating a set, so the key order of the generated `$defs` depends on the
hash seed.

Review the diff before committing: every change here is a deliberate
parity-contract change and needs a matching TypeScript change.
"""

import json
from pathlib import Path

from fastmcp.server.providers.openapi import OpenAPIProvider
from fastmcp.server.providers.openapi.routing import MCPType, RouteMap

HERE = Path(__file__).parent

RUNS = [
    ("petstore-3.1", "default", {}),
    (
        "petstore-3.1",
        "components",
        {
            "route_maps": [
                RouteMap(
                    methods=["GET"],
                    pattern=r"^/search$",
                    mcp_type=MCPType.EXCLUDE,
                ),
                RouteMap(
                    methods=["GET"],
                    pattern=r".*\{.*",
                    mcp_type=MCPType.RESOURCE_TEMPLATE,
                    mcp_tags={"templated"},
                ),
                RouteMap(methods=["GET"], mcp_type=MCPType.RESOURCE),
            ],
            "tags": {"api"},
        },
    ),
    (
        "petstore-3.1",
        "permissive",
        {
            "validate_output": False,
            "mcp_names": {"listPets": "pets_index"},
        },
    ),
    ("edge-cases-3.0", "default", {}),
]


def dump_provider(provider: OpenAPIProvider) -> dict:
    return {
        "tools": [
            {
                "name": t.name,
                "description": t.description,
                "inputSchema": t.parameters,
                "outputSchema": t.output_schema,
                "tags": sorted(t.tags),
            }
            for t in provider._tools.values()
        ],
        "resources": [
            {
                "uri": str(r.uri),
                "name": r.name,
                "description": r.description,
                "mimeType": r.mime_type,
                "tags": sorted(r.tags),
            }
            for r in provider._resources.values()
        ],
        "resourceTemplates": [
            {
                "uriTemplate": t.uri_template,
                "name": t.name,
                "description": t.description,
                "mimeType": t.mime_type,
                "parameters": t.parameters,
                "tags": sorted(t.tags),
            }
            for t in provider._templates.values()
        ],
    }


def main() -> None:
    for spec_name, config_name, kwargs in RUNS:
        spec = json.loads((HERE / f"{spec_name}.json").read_text())
        provider = OpenAPIProvider(openapi_spec=spec, **kwargs)
        snapshot = dump_provider(provider)
        out = HERE / f"{spec_name}.{config_name}.snapshot.json"
        out.write_text(json.dumps(snapshot, indent=2) + "\n")
        print(
            f"wrote {out.name}: {len(snapshot['tools'])} tools, "
            f"{len(snapshot['resources'])} resources, "
            f"{len(snapshot['resourceTemplates'])} templates"
        )


if __name__ == "__main__":
    main()
