import json
from pathlib import Path

project = "Arranged Agents"
release = json.loads(
    (Path(__file__).resolve().parent.parent / "package.json").read_text(
        encoding="utf-8"
    )
)["version"]
html_theme = "pydata_sphinx_theme"
html_logo = "../media/icon.svg"
html_favicon = "../media/icon.svg"
html_theme_options = {
    "github_url": "https://github.com/xadupre/arranged-agents",
    "logo": {"text": release},
    "header_links_before_dropdown": 10,
}
