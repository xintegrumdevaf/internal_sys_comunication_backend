import { describe, expect, it, vi } from "vitest";
import { buildPhoneDigitVariants } from "../../src/core/modules/customers/infrastructure/postgres/customer-search.helper";
import { CustomerRepositoryPg } from "../../src/core/modules/customers/infrastructure/postgres/customer.repository.pg";
import type { Pool } from "pg";

describe("buildPhoneDigitVariants", () => {
  it("normalizes Ecuador 593 and 09 prefixes plus formatted phone numbers", () => {
    expect(buildPhoneDigitVariants("593987481073")).toEqual([
      "%593987481073%",
      "%987481073%",
      "%0987481073%",
    ]);

    expect(buildPhoneDigitVariants("0987481073")).toEqual([
      "%0987481073%",
      "%987481073%",
      "%593987481073%",
    ]);

    expect(buildPhoneDigitVariants("+593 987 481 073")).toEqual([
      "%593987481073%",
      "%987481073%",
      "%0987481073%",
    ]);
  });

  it("returns empty array for short queries or non-digit names", () => {
    expect(buildPhoneDigitVariants("CUEVA SARANGO")).toEqual([]);
    expect(buildPhoneDigitVariants("123")).toEqual([]);
  });
});

describe("CustomerRepositoryPg.list search SQL", () => {
  it("searches linked conversations and normalized phone digit variants when querying by phone", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ count: "0" }] });
    const repo = new CustomerRepositoryPg({ query: queryMock } as unknown as Pool);

    await repo.list({ search: "593987481073", limit: 15, offset: 0 });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain("EXISTS (");
    expect(sql).toContain("FROM conversation conv");
    expect(sql).toContain("conv.customer_id = c.id");
    expect(sql).toContain("regexp_replace(COALESCE(conv.wa_phone");
    expect(params).toEqual([
      "%593987481073%",
      ["%593987481073%", "%987481073%", "%0987481073%"],
    ]);
  });
});
