import { describe, expect, it } from "vitest";
import { BitbucketProvider } from "../src/index.js";
describe("BitbucketProvider", () => {
  it("identifies cloud remotes", () => {
    expect(new BitbucketProvider().identify({name:"origin",fetchUrl:"git@bitbucket.org:acme/app.git"})).toEqual({provider:"bitbucket",owner:"acme",name:"app"});
  });
  it("does not claim Data Center remotes", () => {
    expect(new BitbucketProvider().identify({name:"origin",fetchUrl:"https://stash.acme.test/scm/team/app.git"})).toBeNull();
  });
});
