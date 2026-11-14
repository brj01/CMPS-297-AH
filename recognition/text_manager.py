class TextManager:
    def __init__(self) -> None:
        self.text = ""

    def add(self, letter: str | None) -> str:
        if letter:
            self.text += letter
        return self.text
    def space(self) -> str:
        self.text += " "
        return self.text
    def delete(self) -> str:
        self.text = self.text[:-1]
        return self.text
    def clear(self) -> str:
        self.text = ""
        return self.text

