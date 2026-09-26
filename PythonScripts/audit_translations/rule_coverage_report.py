"""Format file and rule coverage events as Markdown and an interactive HTML report."""

from collections import defaultdict
from html import escape

type RuleKey = tuple[str, str, str]


def section(title: str, paths: set[str]) -> str:
    """List covered YAML paths in a Markdown section."""
    lines = [f"## {title} ({len(paths)})"]
    lines.extend(f"- `{path}`" for path in sorted(paths))
    return "\n".join(lines) + "\n"


def rule_section(title: str, rules: set[RuleKey]) -> str:
    """List active rules with their source path, name, and MathML tag."""
    lines = [f"## {title} ({len(rules)})"]
    lines.extend(f"- `{path}`: `{name}` (`{tag}`)" for path, name, tag in sorted(rules))
    return "\n".join(lines) + "\n"


def render_html(
    loaded: set[str],
    matched: set[str],
    defined_rules: set[RuleKey],
    matched_rules: set[RuleKey],
    errors: list[str],
) -> str:
    """Show file coverage and searchable rule details in a standalone page."""
    rules_by_path: dict[str, list[tuple[str, str, bool]]] = defaultdict(list)
    for path, name, tag in defined_rules:
        rules_by_path[path].append((name, tag, (path, name, tag) in matched_rules))

    problems = ""
    if errors:
        problems = "<section class=\"problems\"><h2>Problems</h2><ul>" + "".join(
            f"<li>{escape(error)}</li>" for error in errors
        ) + "</ul></section>"

    files = []
    for path in sorted(loaded | matched | rules_by_path.keys()):
        rules = sorted(rules_by_path.get(path, []), key=lambda rule: (rule[0], rule[1]))
        matched_count = sum(is_matched for _, _, is_matched in rules)
        status = "matched" if path in matched else "unmatched"
        if rules:
            rule_items = "".join(
                f'<li data-rule-search="{escape(f"{name} {tag}", quote=True)}" '
                f'data-status="{"matched" if is_matched else "unmatched"}">'
                f'<span class="badge {"matched" if is_matched else "unmatched"}">'
                f'{"Matched" if is_matched else "No match"}</span> '
                f'<span class="rule-name">{escape(name)}</span> '
                f'<code>{escape(tag)}</code></li>'
                for name, tag, is_matched in rules
            )
            contents = f"<p>{matched_count} of {len(rules)} active rules matched</p><ul class=\"rules\">{rule_items}</ul>"
        else:
            contents = '<p class="empty">No active pattern rules</p>'
        files.append(
            f'<details class="file" data-file-search="{escape(path, quote=True)}" data-status="{status}">'
            f'<summary><span class="badge {status}">{"Matched" if path in matched else "No match"}</span> '
            f'<code>{escape(path)}</code> <span class="count">{matched_count}/{len(rules)} rules</span></summary>'
            f'{contents}</details>'
        )

    status = "Incomplete" if errors else "Complete"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rule YAML coverage</title>
<style>
body {{ max-width: 75rem; margin: 2rem auto; padding: 0 1rem; font: 1rem/1.5 system-ui, sans-serif; color: #17212b; }}
h1, h2 {{ line-height: 1.2; }}
.summary {{ display: flex; flex-wrap: wrap; gap: .5rem 2rem; }}
.problems {{ padding: .5rem 1rem; background: #fff0ed; border-left: .25rem solid #b42318; }}
.controls {{ display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.5rem 0; }}
input, select {{ font: inherit; padding: .35rem .5rem; }}
input {{ flex: 1 1 20rem; }}
.file {{ border: 1px solid #cad4dc; border-radius: .4rem; margin: .5rem 0; padding: .6rem 1rem; }}
summary {{ cursor: pointer; }}
.count {{ float: right; color: #52616d; }}
.badge {{ display: inline-block; border-radius: .3rem; padding: .05rem .4rem; font-size: .85rem; font-weight: 600; }}
.badge.matched {{ color: #155c36; background: #dcf5e5; }}
.badge.unmatched {{ color: #8b3d00; background: #fff0cf; }}
.rules {{ list-style: none; padding-left: 1rem; }}
.rules li {{ padding: .2rem 0; }}
.rule-name {{ font-weight: 600; }}
.empty {{ color: #52616d; }}
[hidden] {{ display: none !important; }}
</style>
</head>
<body>
<h1>Rule YAML coverage</h1>
<p>Status: <strong>{status}</strong></p>
<div class="summary"><span>{len(loaded)} files loaded</span><span>{len(matched)} pattern files matched</span>
<span>{len(matched_rules)} of {len(defined_rules)} active rules matched</span></div>
<p>Paths are relative to <code>Rules/</code>. A pattern file is matched when a rule from it
completes its replacement successfully.</p>
{problems}
<div class="controls"><input id="search" type="search" aria-label="Search files and rules"
placeholder="Search paths, rule names, or tags">
<select id="status" aria-label="Filter by coverage"><option value="all">All</option>
<option value="matched">Matched</option><option value="unmatched">No match</option></select></div>
<div id="files">{"".join(files)}</div>
<p id="no-results" hidden>No matching files or rules</p>
<script>
const search = document.getElementById('search');
const status = document.getElementById('status');
const files = [...document.querySelectorAll('.file')];
function filter() {{
  const query = search.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const file of files) {{
    const pathMatches = file.dataset.fileSearch.toLocaleLowerCase().includes(query);
    let visibleRules = 0;
    for (const rule of file.querySelectorAll('[data-rule-search]')) {{
      const show = (status.value === 'all' || rule.dataset.status === status.value)
        && (pathMatches || rule.dataset.ruleSearch.toLocaleLowerCase().includes(query));
      rule.hidden = !show;
      if (show) visibleRules++;
    }}
    const fileStatusMatches = status.value === 'all' || file.dataset.status === status.value;
    const showFile = (pathMatches && fileStatusMatches) || visibleRules > 0;
    file.hidden = !showFile;
    if (showFile) visible++;
  }}
  document.getElementById('no-results').hidden = visible > 0;
}}
search.addEventListener('input', filter);
status.addEventListener('change', filter);
</script>
</body>
</html>
"""
