package com.tms.terminal.bubble

import org.junit.Assert.assertEquals
import org.junit.Test

class TextMergeTest {
    @Test fun insertsAtCursorWithLeadingSpace() =
        assertEquals("Hallo Welt" to 10, mergeAtSelection("Hallo", 5, 5, "Welt"))

    @Test fun noExtraSpaceAfterWhitespaceOrAtStart() {
        assertEquals("Hallo Welt" to 10, mergeAtSelection("Hallo ", 6, 6, "Welt"))
        assertEquals("Welt" to 4, mergeAtSelection("", 0, 0, "Welt"))
    }

    @Test fun replacesTheSelection() =
        assertEquals("Ich mag Tee" to 11, mergeAtSelection("Ich mag Kaffee", 8, 14, "Tee"))

    @Test fun insertsInTheMiddleWithoutDoubleSpace() =
        assertEquals("A neu B" to 5, mergeAtSelection("A B", 1, 1, " neu"))

    @Test fun unknownSelectionAppends() =
        assertEquals("Hallo Welt" to 10, mergeAtSelection("Hallo", -1, -1, "Welt"))

    @Test fun reversedOrOutOfRangeSelectionIsClamped() =
        assertEquals("Hal Welt" to 8, mergeAtSelection("Hallo", 99, 3, "Welt"))

    // Review M2: the piece that actually gets pasted (with its joining space);
    // a mixed -1 selection crashed the old substring arithmetic.
    @Test fun insertedPieceCarriesTheJoiningSpace() =
        assertEquals(" Welt", insertedPiece("Hallo", 5, 5, "Welt"))

    @Test fun insertedPieceSurvivesMixedUnknownSelection() {
        assertEquals(" Welt", insertedPiece("Hallo", -1, 3, "Welt"))
        assertEquals("Welt", insertedPiece("", -1, -1, "Welt"))
    }
}
