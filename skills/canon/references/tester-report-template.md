# Tester Reference: Principle-Driven Gap Patterns

Patterns to check when reviewing implementor tests against applied principles.

---

If **errors-are-values** was applied:
- Check that EVERY error branch in result types is tested
- If any are missing, write the missing error branch tests

If **thin-handlers** was applied:
- Verify handlers are tested with mocked services, not real ones
- If missing, write delegation-only handler tests

If **test-the-sad-path** applies:
- Check that failure modes and edge cases are tested
- Fill in missing sad-path tests
