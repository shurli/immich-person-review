# Temporary extraction workbench

The original source is pinned to 724b58b8343b6b3f425ec51d92ab00fd96eb2aac.
The generator removes only tag-specific sections from Person Review and assembles
an independent tag server/UI with the existing editor and calibration algorithms.
Every source file is plain text. Tests use fake services and temporary storage.
No production Immich API or database is accessed by this workflow.

The workbench and its privileged one-time workflow are removed after both source
trees have been committed and verified. Neither final app needs this directory.
