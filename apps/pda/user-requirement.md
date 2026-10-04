# Introduction

this sub project is to, simplfly the `/web` package, the web package is the first run of the concept, which may contains many obsolete logic. so we need to clean up the `/web` package and make it more maintainable. that's why we created this sub project.
also i want to design a more easy to use interface for users to use. current version show too many data, a worker do not need to that much, i want to just show what they need, by also keep it flexible, so i want to enhance admin view setting to allow admin to customize the view. current version of admin custom view setting is not easy to use, it only allow user to set what fields to show, but the layout is not flexible, so i want to enhance it to allow admin to customize the layout.

### Comment on current ui

- List
  - do not use left and right layout, in most of the list , the title length is not fix and may be very long, so use a single column layout instead.
- Reciving order detail
  - allow user to group item by invoice and carton, or gorup item with same part no together.
