import { CategoriesService } from './categories.service';

describe('CategoriesService.list', () => {
  it('seeds an empty tenant before returning its categories', async () => {
    const category = {
      findMany: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'seed-category', name: 'Outras' }]),
      createMany: jest.fn().mockResolvedValue({ count: 12 }),
    };
    const service = new CategoriesService({ category } as never);

    await expect(service.list('tenant-empty')).resolves.toEqual([
      { id: 'seed-category', name: 'Outras' },
    ]);

    expect(category.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });
});
