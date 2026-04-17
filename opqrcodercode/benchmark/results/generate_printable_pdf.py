import os
import sys
import argparse
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from PIL import Image

def get_image_files(directory):
    """
    指定されたディレクトリ内を再帰的に探索して画像ファイルを取得する
    """
    extensions = ('.png', '.jpg', '.jpeg', '.gif', '.bmp')
    path = Path(directory)
    # rglob('*') を使用してサブディレクトリを含め再帰的に探索
    return [str(f) for f in path.rglob('*') if f.suffix.lower() in extensions and f.is_file()]

def create_printable_pdf(directory):
    """
    画像をA4 PDFに配置して出力する
    """
    target_dir = Path(directory)
    if not target_dir.is_dir():
        print(f"Error: Directory not found: {directory}")
        return

    images = get_image_files(directory)
    if not images:
        print("No image files found in the directory (including subdirectories).")
        return

    # 出力ファイルは指定されたルートディレクトリの直下に作成
    output_path = target_dir / "printable.pdf"
    
    # A4 dimensions in points (1 point = 1/72 inch)
    page_width, page_height = A4
    
    # Layout settings
    margin = 20 * mm
    qr_size = 40 * mm  # QR code size
    spacing = 20 * mm  # Space between QR codes
    
    # Calculate grid
    cols = int((page_width - 2 * margin + spacing) // (qr_size + spacing))
    rows = int((page_height - 2 * margin + spacing) // (qr_size + spacing))
    
    cols = max(1, cols)
    rows = max(1, rows)
    images_per_page = cols * rows
    
    # Adjust spacing for better centering
    actual_content_width = cols * qr_size + (cols - 1) * spacing
    start_x = (page_width - actual_content_width) / 2
    
    actual_content_height = rows * qr_size + (rows - 1) * spacing
    start_y = page_height - ((page_height - actual_content_height) / 2) - qr_size

    c = canvas.Canvas(str(output_path), pagesize=A4)
    
    count = 0
    for img_path in sorted(images):
        if count > 0 and count % images_per_page == 0:
            c.showPage()  # New page
            
        # Calculate position in grid
        idx = count % images_per_page
        col = idx % cols
        row = idx // cols
        
        x = start_x + col * (qr_size + spacing)
        y = start_y - row * (qr_size + spacing)
        
        try:
            # Draw image
            c.drawImage(img_path, x, y, width=qr_size, height=qr_size, preserveAspectRatio=True)
            
            # Draw filename below image (small text)
            c.setFont("Helvetica", 6)
            filename = os.path.basename(img_path)
            c.drawCentredString(x + qr_size/2, y - 8, filename)
            
        except Exception as e:
            print(f"Skipping {img_path}: {e}")
            continue
            
        count += 1
    
    c.save()
    print(f"Successfully created: {output_path}")
    print(f"Total images processed (recursive): {count}")
    print(f"Layout: {cols} columns x {rows} rows per page")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Arrange QR code images onto an A4 PDF recursively.")
    parser.add_argument("directory", help="Path to the directory containing image files.")
    
    args = parser.parse_args()
    create_printable_pdf(args.directory)