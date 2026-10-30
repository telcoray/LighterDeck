"""Language of user-facing server messages (Italian or English).

The UI sends its language in the X-Lang header; main.py stores it for the request.
Background work (the automation engine) uses the language the UI last asked for.
"""
import contextvars

_request_lang = contextvars.ContextVar("lang", default=None)
_last_seen = "it"


def set_lang(value):
    global _last_seen
    lang = "en" if (value or "").lower().startswith("en") else "it"
    _last_seen = lang
    _request_lang.set(lang)


def lang():
    return _request_lang.get() or _last_seen


def L(it, en):
    """Pick the Italian or English wording of a message."""
    return en if lang() == "en" else it
