"""Launch full 3D studio or classic Blender converter."""
import sys

if __name__ == "__main__":
    if "--classic" in sys.argv:
        from gfpak_open.gui import main
    else:
        from gfpak_open.desktop import main
    main()
