import { beforeEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { RouteMeta } from "./seo";
import routes from "./seoRoutes.json";

let navigate: (to: string) => void;
const Capture = () => {
  navigate = useNavigate();
  return null;
};

const description = () => document.querySelector('meta[name="description"]')?.getAttribute("content");
const canonical = () => document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;

describe("RouteMeta", () => {
  beforeEach(() => {
    document.head.innerHTML =
      '<meta name="description" content="initial" /><link rel="canonical" href="https://example.test/" />';
  });

  it("sets the title, description and canonical for the route and follows navigation", () => {
    render(
      <MemoryRouter initialEntries={["/terms/"]}>
        <RouteMeta />
        <Routes>
          <Route path="*" element={<Capture />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(document.title).toBe(routes["/terms"].title);
    expect(description()).toBe(routes["/terms"].description);
    expect(canonical()).toMatch(/\/terms$/);

    act(() => navigate("/"));
    expect(document.title).toBe(routes["/"].title);
    expect(description()).toBe(routes["/"].description);
    expect(canonical()).toMatch(/\/$/);
  });

  it("falls back to the landing title on unknown routes and leaves the other tags alone", () => {
    render(
      <MemoryRouter initialEntries={["/privacy"]}>
        <RouteMeta />
      </MemoryRouter>,
    );
    expect(document.title).toBe(routes["/privacy"].title);
    render(
      <MemoryRouter initialEntries={["/nope"]}>
        <RouteMeta />
      </MemoryRouter>,
    );
    expect(document.title).toBe(routes["/"].title);
    expect(description()).toBe(routes["/privacy"].description);
  });
});
