import os
import subprocess
import json
from pathlib import Path

ZOXIDE_DATA_FILE = "~/.cache/zoxide/data"
ZOXIDE_LIMIT_DEFAULT = 10

def _get_zoxide_cache_path():
    """Resolve the path to the zoxide data file dynamically."""
    base = Path("~/.cache").expanduser()
    data_file = base / "zoxide" / "data"
    return data_file

def _parse_zoxide_data(limit: int = ZOXIDE_LIMIT_DEFAULT):
    """Read and parse the Zoxide data file to get recent paths."""
    data_file = _get_zoxide_cache_path()

    if data_file.exists():
        try:
            with data_file.open("r", encoding="utf-8") as f:
                cache_data = json.load(f)
            # Zoxide stores data as a list of dicts usually under 'data' key or root
            items = cache_data.get("data", [])
            return [tuple(item) for item in items][:limit]
        except (json.JSONDecodeError, KeyError):
            return []
    return []

def recent_paths(
    limit: int = ZOXIDE_LIMIT_DEFAULT,
    binary: str = "zoxide"
) -> list[tuple[str, int]]:
    """
    Retrieves the list of recently used paths from zoxide cache.
    Designed for Omarchy/Quickshell plugin integration.
    
    Args:
        limit: Number of paths to return.
        binary: Path to the zoxide binary (for dynamic pathing).
    
    Returns:
        List of (path, count) tuples.
    """
    # Ensure Zoxide is available
    if binary and binary not in os.environ.get("PATH", ""):
        # Fallback to finding binary location if needed
        binary = subprocess.run(f"{binary} path", shell=True, capture_output=True, text=True).stdout.strip()
        
    # Get cache path (or derive it from zoxide query path if cache is elusive)
    # Using a more robust detection for the cache file
    cache_path = _get_zoxide_cache_path()
    
    if not cache_path.exists():
        # Quick fallback: query zoxide directly for paths
        # This handles the case where cache exists but JSON structure is new
        zoxide_query = subprocess.run(f"{binary} query", shell=True, capture_output=True, text=True)
        if zoxide_query.returncode == 0:
            # Zoxide query usually outputs simple lines: `path count`
            lines = zoxide_query.stdout.strip().split("\n")
            return [(line, i+1) for i, line in enumerate(lines) if line]
        return []
    
    return _parse_zoxide_data(limit)

def init_shell_hook():
    """
    Configures the shell environment for Omarchy integration.
    Ensures the plugin variables are set without overwriting core config.
    """
    import sys
    import os

    # Determine where this plugin lives
    script_dir = Path(__file__).parent
    hook_var = "OMARCHY_RECENT_PATHS_LIMIT"
    hook_limit = str(ZOXIDE_LIMIT_DEFAULT)

    # Set default env if not present
    if hook_var not in os.environ:
        os.environ[hook_var] = hook_limit

    # Define the function in the current namespace if sourcing directly
    if "recent_paths" not in globals():
        globals()["recent_paths"] = recent_paths
        
    return recent_paths()

def run():
    """Main entry point for the Omarchy plugin runner."""
    return recent_paths()

if __name__ == "__main__":
    # Entry point if invoked directly
    for path, count in run():
        print(f"{path}\t{count}")