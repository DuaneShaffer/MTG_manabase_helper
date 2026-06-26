"""Small shared helpers."""


def list_of_seq_unique_by_key(seq, key):
    """Return items of ``seq`` deduped by ``item[key]``, keeping first seen.

    Order-preserving: the first occurrence of each key wins. Previously this
    was copy-pasted into all three scripts; it now lives here once.
    """
    seen = set()
    seen_add = seen.add
    return [x for x in seq if x[key] not in seen and not seen_add(x[key])]
