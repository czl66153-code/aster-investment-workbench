"""Standalone adapters for the original AIA selection logic.

The package deliberately has no dependency on the legacy 8000 process and does
not import provider SDKs.  Provider results enter through explicit JSON
contracts so that credentials stay in the scheduler/runtime environment.
"""

from .assets import load_asset_manifest, validate_assets
from .m30 import evaluate_m30, load_template_profile
from .ranking import load_current_config, rank_top10
from .sources import source_plan

__all__ = [
    "evaluate_m30",
    "load_asset_manifest",
    "load_current_config",
    "load_template_profile",
    "rank_top10",
    "source_plan",
    "validate_assets",
]

__version__ = "0.1.0"
