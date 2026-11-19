"""Real Python FastMCP peer for the TypeScript skills interoperability suite."""

import asyncio
import base64
import json
import sys

from fastmcp import Client, FastMCP, Skill
from fastmcp.skills import SkillsClientExtension
from fastmcp.skills.provider import SkillCatalogProvider

FILES = {
    'SKILL.md': b'\xef\xbb\xbf---\r\nname: review\r\ndescription: Review code.\r\n---\r\n\r\nRead guide one.md.\r\n',
    'guide one.md': b'Use tests.\r\n',
    'data.bin': bytes([0, 255, 13, 10]),
}


def serve(port: int) -> None:
    other = Skill(name='checkout', description='Check out a cart.', instructions='Confirm the cart.')
    mcp = FastMCP('Python Skills', providers=[SkillCatalogProvider([Skill.from_files(FILES), other])], list_page_size=1)
    mcp.run(transport='http', host='127.0.0.1', port=port, show_banner=False)


def proxy(port: int, backend: str) -> None:
    from fastmcp.server import create_proxy

    upstream = create_proxy(backend, skills=True)
    mcp = FastMCP('Python Gateway')
    mcp.mount(upstream, namespace='upstream')
    mcp.run(transport='http', host='127.0.0.1', port=port, show_banner=False)


async def read(url: str, uri: str, extension: bool) -> None:
    extensions = [SkillsClientExtension()] if extension else []
    async with Client(url, mode='auto', extensions=extensions) as client:
        skill = await client.read_skill(uri)
        print(json.dumps({path: base64.b64encode(data).decode() for path, data in skill.files.items()}), flush=True)


if __name__ == '__main__':
    if sys.argv[1] == 'serve':
        serve(int(sys.argv[2]))
    elif sys.argv[1] == 'proxy':
        proxy(int(sys.argv[2]), sys.argv[3])
    else:
        asyncio.run(read(sys.argv[2], sys.argv[3], sys.argv[4] == 'extension'))
