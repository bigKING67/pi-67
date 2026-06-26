<!-- ~/.pi/agent/prompts/review.md -->
Review the recent code changes for:

1. **Bugs & Logic Errors**: edge cases, null/undefined handling, race conditions
2. **Security**: injection risks, hardcoded secrets, missing input validation
3. **Performance**: N+1 queries, unnecessary re-renders, large allocations in hot paths
4. **Code Quality**: naming clarity, function length, unnecessary abstraction, duplicated logic
5. **Error Handling**: swallowed errors, silent fallbacks, missing error boundaries

Output format:
- 🔴 Critical (must fix)
- 🟡 Warning (should fix)
- 🔵 Suggestion (nice to have)
- ✅ Already Solid

{{focus}}
