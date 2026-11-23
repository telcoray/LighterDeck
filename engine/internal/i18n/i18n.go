// Package i18n picks the Italian or English wording of a message, as backend/i18n.py does: the language the
// site last asked in (each call from the Python server says it), English for every language but Italian.
package i18n

import (
	"strings"
	"sync/atomic"
)

var english atomic.Bool

// Set records the language of the latest request ("it", "en", "zh", ...).
func Set(lang string) {
	if lang == "" {
		return
	}
	english.Store(!strings.HasPrefix(strings.ToLower(lang), "it"))
}

// L returns the Italian or the English wording.
func L(it, en string) string {
	if english.Load() {
		return en
	}
	return it
}
