// Single translation unit that emits the inline MCAP implementation.
// The foxglove/mcap library is header-only; defining MCAP_IMPLEMENTATION
// here forces the out-of-line symbols to be materialized exactly once.

#define MCAP_IMPLEMENTATION
#include <mcap/mcap.hpp>
