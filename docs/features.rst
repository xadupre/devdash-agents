Features
========

DevDash Agents groups its user-facing capabilities by topic: GitHub queries
and the rest of the application. Start with :doc:`getting_started` for
installation and a first conversation.

.. figure:: images/workspace.png
   :alt: Three-panel workspace with GitHub issues, a Copilot conversation and repository sessions.

   Repository activity, conversation and independent sessions in one tab.
   Screenshots throughout this guide use illustrative demo data rendered by the
   application webview, not a live Copilot conversation or GitHub activity.

GitHub queries
--------------

Browse the selected repository's activity independently of Copilot.

.. toctree::
   :maxdepth: 1

   features/github_activity

* :doc:`features/github_activity` covers issues, reviews, comments, mentions and
  commits.

The rest
--------

Workspace navigation, Copilot conversations and application controls.

.. toctree::
   :maxdepth: 1

   features/workspace
   features/conversations
   features/parallel_work
   features/sessions
   features/postmortem
   features/settings
   features/safeguards

* :doc:`features/workspace` explains the two-panel layout, repository
  discovery and navigation.
* :doc:`features/conversations` describes chat input, rendering, attachments,
  transcript filters and token counts.
* :doc:`features/parallel_work` explains immediate parallel requests and queued
  main-session follow-ups.
* :doc:`features/sessions` covers isolated repository sessions, persistence,
  recovery and deletion.
* :doc:`features/postmortem` documents evidence-linked conversation reports and
  JSON export.
* :doc:`features/settings` lists the CLI, model and timeout controls.
* :doc:`features/safeguards` details permission handling, data boundaries,
  content security and known limitations.
