import sys
import os

# Adiciona o diretório base ao path do Python para poder importar app
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import Base, _get_engine
from app.models.notification import Notification

def main():
    engine = _get_engine()
    print("Criando tabela notifications...")
    Base.metadata.create_all(bind=engine, tables=[Notification.__table__])
    print("Tabela notifications criada com sucesso!")

if __name__ == "__main__":
    main()
