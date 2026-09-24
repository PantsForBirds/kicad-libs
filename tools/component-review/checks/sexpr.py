"""Minimal KiCad s-expression parser (stdlib only).

Parses into `Node` objects that remember the 1-based source line where each list
opens, so checks can cite lines. Atoms are returned as `str` (quoted strings are
unquoted; bare tokens kept as-is).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Node:
    name: str
    items: list = field(default_factory=list)  # str atoms and child Nodes, in order
    line: int = 0  # 1-based line of the opening "(" within the parsed text

    # --- navigation helpers -------------------------------------------------
    def children(self, name: str | None = None) -> list["Node"]:
        return [c for c in self.items if isinstance(c, Node) and (name is None or c.name == name)]

    def child(self, name: str) -> "Node | None":
        for c in self.items:
            if isinstance(c, Node) and c.name == name:
                return c
        return None

    def atoms(self) -> list[str]:
        return [a for a in self.items if isinstance(a, str)]

    def atom(self, i: int = 0, default: str | None = None) -> str | None:
        a = self.atoms()
        return a[i] if i < len(a) else default

    def value(self, name: str, i: int = 0, default: str | None = None) -> str | None:
        c = self.child(name)
        return c.atom(i, default) if c else default

    def floats(self) -> list[float]:
        out = []
        for a in self.atoms():
            try:
                out.append(float(a))
            except ValueError:
                pass
        return out

    def has_flag(self, flag: str) -> bool:
        """True for a bare atom `flag`, or `(flag yes)` (KiCad 7+ style)."""
        if flag in self.atoms():
            return True
        c = self.child(flag)
        return c is not None and (c.atom(0) in (None, "yes"))

    def walk(self):
        yield self
        for c in self.items:
            if isinstance(c, Node):
                yield from c.walk()


class ParseError(ValueError):
    pass


def parse(text: str) -> Node:
    """Parse the first top-level list in `text`."""
    nodes = parse_all(text)
    if not nodes:
        raise ParseError("no s-expression found")
    return nodes[0]


def parse_all(text: str) -> list[Node]:
    tops: list[Node] = []
    stack: list[Node] = []
    i, n, line = 0, len(text), 1
    while i < n:
        ch = text[i]
        if ch == "\n":
            line += 1
            i += 1
        elif ch in " \t\r":
            i += 1
        elif ch == "(":
            node = Node(name="", line=line)
            if stack:
                stack[-1].items.append(node)
            else:
                tops.append(node)
            stack.append(node)
            i += 1
        elif ch == ")":
            if not stack:
                raise ParseError(f"unbalanced ')' at line {line}")
            stack.pop()
            i += 1
        elif ch == '"':
            j = i + 1
            buf = []
            while j < n and text[j] != '"':
                if text[j] == "\\" and j + 1 < n:
                    nxt = text[j + 1]
                    buf.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt))
                    j += 2
                    continue
                if text[j] == "\n":
                    line += 1
                buf.append(text[j])
                j += 1
            if j >= n:
                raise ParseError(f"unterminated string starting line {line}")
            _add_atom(stack, "".join(buf), quoted=True)
            i = j + 1
        else:
            j = i
            while j < n and text[j] not in ' \t\r\n()"':
                j += 1
            _add_atom(stack, text[i:j], quoted=False)
            i = j
    if stack:
        raise ParseError(f"unbalanced '(' opened at line {stack[-1].line}")
    return tops


def _add_atom(stack: list[Node], tok: str, quoted: bool) -> None:
    if not stack:
        return  # stray atom outside any list: ignore
    cur = stack[-1]
    if cur.name == "" and not quoted and not cur.items:
        cur.name = tok
    else:
        cur.items.append(tok)
