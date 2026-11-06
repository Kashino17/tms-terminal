import prompt_rewriter_sidecar as rw


# A 4-minute dictation is ~900 tokens; a fixed 512-token cap cut it off silently.
def test_budget_has_a_floor_of_512():
    assert rw.max_tokens_for(10) == 512


def test_budget_scales_with_long_input():
    assert rw.max_tokens_for(900) == 1800
