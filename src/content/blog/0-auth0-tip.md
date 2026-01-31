---
title: "Auth0 Tip: Populating YAML Arrays with Environment Variables"
description: " Using keyword replacement and inline YAML arrays "
date: 2026-01-29
tags: ["auth0"]
draft: false
---

If you've worked with Auth0's Deploy CLI, you've probably run into a scenario where you need to populate a YAML array dynamically—say, a list of allowed callback URLs or origins that differ between environments.

The naive approach? Create multiple environment variables for each array item and use keyword replacement mapping to inject the values into a YAML array. But this is problematic, since you don't know how many array elements you'll need per environment. We were scratching our heads and thinking we needed to write a custom script to parse the tenant.yaml and then inject the array dynamically that way.

But there's a cleaner way that surprisingly few people know about: keyword replacement mapping with the ## syntax combined with YAML's inline array notation.

## The Problem

Imagine you have an Auth0 client configuration that needs different callback URLs per environment:

```yaml
# tenant.yaml - client metadata
callbacks:
  - https://dev.example.com/callback
  - https://dev.example.com/auth
``` 

For production, you'd need entirely different values.

## The Solution: Keyword Replacement + Inline Arrays

Auth0's Deploy CLI supports keyword replacement using the `##VARIABLE##` syntax. Combined with YAML's inline array syntax `[]`, you can inject comma-separated environment variables directly into arrays.

Here's how it works:

```yaml
# tenant.yaml - client metadata
callbacks: [##ALLOWED_CALLBACKS##]
origins: [##ALLOWED_ORIGINS##]
```

Then set your environment variables with comma-separated values:

```sh
export ALLOWED_CALLBACKS="https://prod.example.com/callback, https://prod.example.com/auth"
export ALLOWED_ORIGINS="https://prod.example.com, https://api.prod.example.com"
```

When the a0deploy CLI processes this configuration, it expands the variables and parses the result as a proper YAML array.

Be sure to avoid using the `@@` syntax - this will perform a `JSON.stringify`, adding quotes around your comma separated values. The resulting array will contain one element instead of many.

## Why This Works

YAML supports two array syntaxes:

```yaml
# Block syntax (traditional)
items:
  - one
  - two
  - three

# Inline/flow syntax
items: [one, two, three]
```

When Auth0's keyword replacement runs, it performs a simple string substitution. The result `[value1, value2, value3]` is valid YAML that gets parsed into an array.

## Wrapping Up

This technique has saved me from having to write a more complicated script to inject the environment vairables into the more conventional array syntax. It's one of those features that isn't prominently documented but makes a real difference in keeping your Auth0 infrastructure-as-code clean and maintainable.

Next time you're setting up the a0deploy CLI, give this pattern a try.
