r"""SEPIA-1 tokenizer specification: special tokens and the code-aware pre-tokenizer.

Single source for train.py, prepare.py and export_ids.py. The TypeScript encoder
(shared/sepia1/tokenizer.ts) reads the same two patterns from tokenizer.json, and its parity
test fails on any difference from the Hugging Face `tokenizers` output.

Pre-tokenization (docs/SEPIA-1.md §2.3), applied before BPE merges. Stage 1 is one regex whose
alternatives are tried in order at each position (leftmost-first):

  1. line breaks plus the indentation of the next line:  (?:\r?\n)+[\t ]*
  2. multi-character operators, atomic (optional leading space):  ..= /// => -> :: == != <= >=
     && || << >> += -= ** // /* */ #[
  3. hex literal with more than 8 digits (whole literal; stage 2 splits it)
  4. hex literal with 1-8 digits, one pre-token (selectors, masks, small constants)
  5. identifier, optionally a dotted chain (letters, digits, _), so msg.sender can be one token
  6. one decimal digit (optional leading space): numbers are split one digit per token
  7. a run of other symbols that stops before any operator in (2), so `);` or `({` can merge but
     `=>` is never split or glued to its neighbours
  8. spaces and tabs not followed by a non-space (the last space joins the next token, GPT-style)
  9. any remaining run of spaces, tabs, \r, \x0B, \x0C

Stage 2 only touches stage-1 pieces that are long hex literals: `0x` (with its optional leading
space) becomes one pre-token and the digits are cut into 4-digit groups, so addresses and hashes
do not use up vocabulary. \A, \z and \G are Oniguruma anchors (start of piece, end of piece,
end of the previous match); every other piece passes through unchanged.

Only ASCII whitespace is treated as whitespace (explicit classes instead of \s, whose Unicode
definition differs between Oniguruma and JavaScript).
"""

OPS = r"\.\.=|///|=>|->|::|==|!=|<=|>=|&&|\|\||<<|>>|\+=|-=|\*\*|//|/\*|\*/|#\["

STAGE1 = "|".join([
    r"(?:\r?\n)+[\t ]*",
    r" ?(?:" + OPS + r")",
    r" ?0[xX][0-9a-fA-F]{9,}(?![\p{L}\p{N}_])",
    r" ?0[xX][0-9a-fA-F]{1,8}(?![\p{L}\p{N}_])",
    r" ?[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*",
    r" ?\p{N}",
    r" ?(?:(?!" + OPS + r")[^\t\n\x0B\x0C\r \p{L}\p{N}_])+",
    r"[\t\x0B\x0C ]+(?![^\t\n\x0B\x0C\r ])",
    r"[\t\x0B\x0C\r ]+",
])

STAGE2 = r"\A ?0[xX](?=[0-9a-fA-F]{9,}\z)|\G(?<=[0-9a-fA-FxX])[0-9a-fA-F]{1,4}"

SPECIALS = [
    "<|endoftext|>",
    "<|pad|>",
    "<|repo|>",
    "<|file|>",
    "<|fim_prefix|>",
    "<|fim_suffix|>",
    "<|fim_middle|>",
] + [f"<|reserved_{i}|>" for i in range(32)]

VOCAB_SIZE = 32768
# HF's BPE trainer does no sampling; the seed fixes our own data sampling (prepare.py).
SEED = 1


def build_tokenizer():
    from tokenizers import Tokenizer, Regex, decoders, models, pre_tokenizers

    tok = Tokenizer(models.BPE())
    tok.pre_tokenizer = pre_tokenizers.Sequence([
        pre_tokenizers.Split(Regex(STAGE1), behavior="isolated"),
        pre_tokenizers.Split(Regex(STAGE2), behavior="isolated"),
        pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False),
    ])
    tok.decoder = decoders.ByteLevel()
    return tok
