// tests/user.test.ts
import { testUsers } from "../fixtures/shared-test-data";

describe("UserService", () => {
  it("should find user by email", () => {
    const user = testUsers[0]; // data lives outside the test
    expect(findByEmail(user.email)).toEqual(user);
  });
});
