"""Format file and rule coverage events as Markdown and an interactive HTML report."""

from collections import defaultdict
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

type RuleKey = tuple[str, str, str]

TEMPLATE = Environment(
    loader=FileSystemLoader(Path(__file__).parent),
    autoescape=select_autoescape(("html",)),
).get_template("rule_coverage.html")


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

    files = []
    for path in sorted(loaded | matched | rules_by_path.keys()):
        rules = sorted(rules_by_path.get(path, []), key=lambda rule: (rule[0], rule[1]))
        files.append(
            {
                "path": path,
                "matched": path in matched,
                "matched_count": sum(is_matched for _, _, is_matched in rules),
                "rule_count": len(rules),
                "rules": [{"name": name, "tag": tag, "matched": is_matched} for name, tag, is_matched in rules],
            }
        )

    return TEMPLATE.render(
        status="Incomplete" if errors else "Complete",
        loaded_count=len(loaded),
        matched_count=len(matched),
        defined_rule_count=len(defined_rules),
        matched_rule_count=len(matched_rules),
        errors=errors,
        files=files,
    )
