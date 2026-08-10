"""Apply the pending Python-side readOnly/writeOnly change to a parity venv.

The fastmcp-ts side of the access-mode filter (input schemas drop readOnly
properties, output schemas drop writeOnly properties) shipped BEFORE the
matching Python FastMCP change. Snapshots must stay pipeline-generated, so
until the Python half lands, regeneration runs against a venv built from
Python main with this script applied first:

    uv venv .tmp/parity-venv
    uv pip install --python .tmp/parity-venv/bin/python \\
        '../../fastmcp/main/fastmcp_slim[server]'
    .tmp/parity-venv/bin/python tests/fixtures/openapi/patch_parity_venv.py
    PYTHONHASHSEED=0 .tmp/parity-venv/bin/python tests/fixtures/openapi/generate_snapshots.py

Python main's OpenAPI parser builds `$defs` by iterating a `set`, so the key
order of the generated `$defs` depends on `PYTHONHASHSEED`; pinning the seed
makes regeneration reproducible across runs.

The three replacements below ARE the pending Python change, byte for byte.
When it lands in Python main, this script's asserts will fail (the old text
is gone); at that point regenerate directly from Python main and delete this
script.
"""

from pathlib import Path

import fastmcp.utilities.openapi.json_schema_converter as jsc
import fastmcp.utilities.openapi.schemas as schemas_mod

OLD_FILTER = '''def _filter_properties_by_access(
    schema: dict[str, Any], remove_read_only: bool, remove_write_only: bool
) -> dict[str, Any]:
    """Remove readOnly and/or writeOnly properties from schema."""
    if "properties" not in schema:
        return schema

    result = schema.copy()
    filtered_properties = {}

    for prop_name, prop_schema in result["properties"].items():
        if not isinstance(prop_schema, dict):
            filtered_properties[prop_name] = prop_schema
            continue

        should_remove = (remove_read_only and prop_schema.get("readOnly")) or (
            remove_write_only and prop_schema.get("writeOnly")
        )

        if not should_remove:
            filtered_properties[prop_name] = prop_schema

    result["properties"] = filtered_properties

    # Clean up required array if properties were removed
    if "required" in result and filtered_properties:
        result["required"] = [
            prop for prop in result["required"] if prop in filtered_properties
        ]
        if not result["required"]:
            result.pop("required")

    return result
'''

NEW_FILTER = '''def _filter_properties_by_access(
    schema: dict[str, Any], remove_read_only: bool, remove_write_only: bool
) -> dict[str, Any]:
    """Remove readOnly and/or writeOnly properties from schema.

    Only names that are actually removed are pruned from `required`; a schema
    with nothing to remove is returned unchanged, so enabling the flags cannot
    alter schemas that carry no readOnly/writeOnly properties.
    """
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return schema

    removed = {
        name
        for name, prop_schema in properties.items()
        if isinstance(prop_schema, dict)
        and (
            (remove_read_only and prop_schema.get("readOnly"))
            or (remove_write_only and prop_schema.get("writeOnly"))
        )
    }
    if not removed:
        return schema

    result = schema.copy()
    result["properties"] = {
        name: prop_schema
        for name, prop_schema in properties.items()
        if name not in removed
    }
    if isinstance(result.get("required"), list):
        result["required"] = [
            prop for prop in result["required"] if prop not in removed
        ]
    return result
'''

REPLACEMENTS = [
    (Path(jsc.__file__), OLD_FILTER, NEW_FILTER),
    (
        Path(schemas_mod.__file__),
        "result = convert_openapi_schema_to_json_schema(result, route.openapi_version)",
        "result = convert_openapi_schema_to_json_schema(\n"
        "            result, route.openapi_version, remove_read_only=True\n"
        "        )",
    ),
    (
        Path(schemas_mod.__file__),
        "output_schema = convert_openapi_schema_to_json_schema(\n"
        "            output_schema, openapi_version\n"
        "        )",
        "output_schema = convert_openapi_schema_to_json_schema(\n"
        "            output_schema, openapi_version, remove_write_only=True\n"
        "        )",
    ),
    (
        Path(schemas_mod.__file__),
        "processed_defs[def_name] = convert_openapi_schema_to_json_schema(\n"
        "                    processed_defs[def_name], openapi_version\n"
        "                )",
        "processed_defs[def_name] = convert_openapi_schema_to_json_schema(\n"
        "                    processed_defs[def_name], openapi_version, remove_write_only=True\n"
        "                )",
    ),
]

for path, old, new in REPLACEMENTS:
    text = path.read_text()
    count = text.count(old)
    assert count == 1, (
        f"{path}: expected exactly 1 occurrence, found {count}. "
        "Python main has drifted; reconcile this script with the current "
        "source before regenerating snapshots."
    )
    path.write_text(text.replace(old, new))
    print(f"patched {path}")
