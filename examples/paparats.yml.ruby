# Ruby/Rails project example
group: "my-fullstack"
language: ruby

indexing:
  paths: ["app/", "lib/", "config/"]
  exclude: ["vendor/**", "tmp/**", "log/**", "spec/**"]

watcher:
  enabled: true
  debounce: 1000
