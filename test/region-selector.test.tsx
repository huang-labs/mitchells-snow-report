// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RegionSelector } from "@/components/RegionSelector";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

it.each(["plumes", "weather"] as const)("keeps %s on Utah even with a previously saved region", (section) => {
  localStorage.setItem("mitchells-snow-report.region", "tahoe");
  render(<RegionSelector section={section} selected="utah" />);
  expect(screen.getByRole("combobox")).toHaveProperty("value", "utah");
  expect(router.replace).not.toHaveBeenCalled();
});

it("keeps explicit regional URLs and changes regions only on selection", () => {
  render(<RegionSelector section="plumes" selected="mammoth" />);
  expect(screen.getByRole("combobox")).toHaveProperty("value", "mammoth");
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "tahoe" } });
  expect(router.push).toHaveBeenCalledWith("/plumes/tahoe");
  expect(localStorage.getItem("mitchells-snow-report.region")).toBeNull();
});

it("keeps Daily Snow on United States West by default", () => {
  localStorage.setItem("mitchells-snow-report.region", "tahoe");
  render(<RegionSelector section="daily-snow" selected="western-us" />);
  expect(screen.getByRole("combobox")).toHaveProperty("value", "western-us");
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "utah" } });
  expect(router.push).toHaveBeenCalledWith("/daily-snow/utah");
  expect(localStorage.getItem("mitchells-snow-report.region")).toBe("tahoe");
});
