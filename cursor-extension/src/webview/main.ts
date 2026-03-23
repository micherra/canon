import App from "./App.svelte";
import { mount } from "svelte";

const target = document.getElementById("app");
if (target) {
  mount(App, { target });
}
