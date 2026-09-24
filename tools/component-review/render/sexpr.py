"""Minimal, robust s-expression parser for KiCad files (v5 .. v10 formats).

Nodes keep their source span (char offsets and 1-based line numbers) so that
callers can cut an item's exact text out of a library file.

Atoms: quoted strings become ``str``; bare tokens become ``Atom`` (a str
subclass), so ``hide`` (flag) and ``"hide"`` (text) can be told apart.
"""

from __future__ import annotations


class Atom(str):
    """Unquoted token, e.g. ``smd``, ``yes``, ``1.27``."""

    __slots__ = ()


class Node(list):
    """A parenthesised list. ``node.name`` is the head token (or '')."""

    __slots__ = ("start", "end", "line_start", "line_end")

    def __init__(self, *args):
        super().__init__(*args)
        self.start = self.end = self.line_start = self.line_end = 0

    @property
    def name(self) -> str:
        return str(self[0]) if self and isinstance(self[0], str) else ""

    # --- navigation helpers -------------------------------------------------
    def children(self, name: str | None = None):
        for c in self[1:]:
            if isinstance(c, Node) and (name is None or c.name == name):
                yield c

    def child(self, name: str):
        for c in self.children(name):
            return c
        return None

    def atoms(self):
        return [c for c in self[1:] if not isinstance(c, Node)]

    def arg(self, i: int = 0, default=None):
        """i-th non-node argument after the head."""
        a = self.atoms()
        return a[i] if i < len(a) else default

    def value(self, name: str, default=None, i: int = 0):
        c = self.child(name)
        if c is None:
            return default
        return c.arg(i, default)

    def num(self, name: str, default=0.0, i: int = 0) -> float:
        v = self.value(name, None, i)
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    def nums(self, name: str | None = None):
        n = self if name is None else self.child(name)
        if n is None:
            return None
        out = []
        for a in n.atoms():
            try:
                out.append(float(a))
            except ValueError:
                pass
        return out

    def flag(self, name: str) -> bool:
        """True for ``(name yes)``, ``(name)`` or a bare ``name`` atom (old formats)."""
        for c in self[1:]:
            if isinstance(c, Node) and c.name == name:
                v = c.arg(0)
                return v is None or str(v) in ("yes", "true")
            if isinstance(c, Atom) and c == name:
                return True
        return False


class ParseError(ValueError):
    pass


def parse(text: str) -> Node:
    """Parse a whole file and return the single top-level node."""
    nodes = parse_all(text)
    if not nodes:
        raise ParseError("empty s-expression")
    return nodes[0]


def parse_all(text: str) -> list[Node]:
    stack: list[Node] = []
    top: list[Node] = []
    i, n, line = 0, len(text), 1
    while i < n:
        ch = text[i]
        if ch == "\n":
            line += 1
            i += 1
        elif ch in " \t\r\f\v":
            i += 1
        elif ch == "(":
            node = Node()
            node.start, node.line_start = i, line
            stack.append(node)
            i += 1
        elif ch == ")":
            if not stack:
                raise ParseError(f"unbalanced ')' at line {line}")
            node = stack.pop()
            node.end, node.line_end = i + 1, line
            (stack[-1].append(node) if stack else top.append(node))
            i += 1
        elif ch == '"':
            j = i + 1
            buf = []
            while j < n and text[j] != '"':
                c = text[j]
                if c == "\\" and j + 1 < n:
                    nxt = text[j + 1]
                    buf.append({"n": "\n", "t": "\t", "r": "\r"}.get(nxt, nxt))
                    j += 2
                    continue
                if c == "\n":
                    line += 1
                buf.append(c)
                j += 1
            if j >= n:
                raise ParseError(f"unterminated string at line {line}")
            s = "".join(buf)
            if stack:
                stack[-1].append(s)
            i = j + 1
        elif ch == "|":
            # KiCad 10 embedded file data: |base64...| possibly spanning lines
            j = text.find("|", i + 1)
            if j < 0:
                raise ParseError(f"unterminated |data| at line {line}")
            chunk = text[i + 1:j]
            line += chunk.count("\n")
            if stack:
                stack[-1].append(Atom("|" + "".join(chunk.split()) + "|"))
            i = j + 1
        else:
            j = i
            while j < n and text[j] not in ' \t\r\n\f\v()"':
                j += 1
            if stack:
                stack[-1].append(Atom(text[i:j]))
            i = j
    if stack:
        raise ParseError(f"unbalanced '(' opened at line {stack[-1].line_start}")
    return top


def _q(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def dumps(node, drop=("uuid",)) -> str:
    """Canonical one-line serialisation, dropping nodes named in ``drop``.

    Used to compare items while ignoring whitespace/uuid-only changes.
    """
    if isinstance(node, Node):
        parts = [dumps(c, drop) for c in node if not (isinstance(c, Node) and c.name in drop)]
        return "(" + " ".join(parts) + ")"
    if isinstance(node, Atom):
        # normalise numbers so "1" == "1.0" == "1.000000"
        try:
            f = float(node)
            if f == 0:
                f = 0.0  # -0 -> 0
            return repr(round(f, 6))
        except ValueError:
            return str(node)
    return _q(str(node))
