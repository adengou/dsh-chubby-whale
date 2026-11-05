export function createStorySource(port) {
    return {
        listBooks: async () => {
            const books = await port.readStoryIndex();
            return books.map((b) => String(b && b.book || '')).filter(Boolean);
        },
        loadBook: (book) => port.readStoryBook(book),
    };
}
